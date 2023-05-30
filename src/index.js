import RAPIER from '@dimforge/rapier3d-compat'
import PhysicsComponent from './PhysicsComponent'
import { BasePlugin } from 'vatom-spaces-plugins'

/**
 * Main physics plugin
 */
export default class RapierPhysicsPlugin extends BasePlugin {

    /** Plugin info */
    static id = "com.vatom.rapier-physics"
    static name = "Rapier Physics"

    /** Instance ID, to identify our own messages */
    instanceID = Date.now() + ':' + Math.random()

    /** Physics simulation rate, in frames per second */
    simulationFPS = 60

    /** Amount of time the last frame took */
    frameDuration = 0

    /** @type {PhysicsComponent[]} All physics objects in the scene. The PhysicsComponent instances add themselves here. */
    physicsObjects = []

    /** @type {RAPIER.EventQueue} Rapier's event queue, used for fetching collision events after a world update */
    eventQueue = null

    /** Analytics */
    numMessagesIn = 0
    numMessagesOut = 0

    /** List of active collisions between objects */
    activeCollisions = []

    /** Called on load */
    async onLoad() {

        // Add hook for debug text
        this.hooks.addHandler('debug.text', () => this.getDebugText())

        // Initialize Rapier
        console.debug(`[Physics] Initializing Rapier...`)
        await RAPIER.init()

        // Create world
        console.debug(`[Physics] Creating physics world...`)
        let gravity = { x: 0.0, y: -9.81, z: 0.0 }
        this.world = new RAPIER.World(gravity)

        // Create the ground
        let groundColliderDesc = RAPIER.ColliderDesc.cuboid(100000, 0.1, 100000)
        this.world.createCollider(groundColliderDesc)

        // Create a collider representing the current user
        this.userBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased())
        this.userCollider = this.world.createCollider(RAPIER.ColliderDesc.cylinder(1.8 / 2, 0.5), this.userBody)

        // Enable collision events for the user's body, so we can send them over the network
        this.userCollider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)

        // Event collector
        this.eventQueue = new RAPIER.EventQueue(true)

        // Start game loop
        setInterval(this.loop.bind(this), 1000/this.simulationFPS)

        // Register component
        PhysicsComponent.register(this)

        // Register hook API
        this.hooks.addHandler('com.vatom.rapier-physics:applyImpulse', this.onHookApplyImpulse.bind(this))
        this.hooks.addHandler('com.vatom.rapier-physics:getState', this.onHookGetState.bind(this))
        this.hooks.addHandler('com.vatom.rapier-physics:setState', this.onHookSetState.bind(this))

    }
    
    /** Called every physics frame */
    loop() {

        // Stop entirely if we don't even have any physics objects
        let hasActiveEntities = this.physicsObjects.find(entity => entity.body)
        if (!hasActiveEntities)
            return

        // Calculate delta
        let now = Date.now()
        let startedAt = now
        let delta = this.lastFrameTime ? (this.lastFrameTime - now) : 0
        this.lastFrameTime = now

        // Step physics forward
        this.world.step(this.eventQueue)

        // Do loop for all objects as well
        for (let object of this.physicsObjects)
            object.loop()

        // Update user collider
        this.updateUserCollider()

        // Fetch collision events
        this.eventQueue.drainCollisionEvents((colliderID1, colliderID2, started) => {

            // Catch errors
            try {

                // Get object ID for colliding objects
                let object1 = this.physicsObjects.find(o => o.colliders?.find(c => c.handle === colliderID1))
                let object1currentUser = colliderID1 == this.userCollider.handle
                let object2 = this.physicsObjects.find(o => o.colliders?.find(c => c.handle === colliderID2))
                let object2currentUser = colliderID2 == this.userCollider.handle

                // Check if should add or remove the collision
                if (started) {

                    // Add new collision
                    let collision = new ActiveCollision()
                    collision.colliderHandle1 = colliderID1
                    collision.colliderHandle2 = colliderID2
                    collision.object1 = object1
                    collision.object2 = object2
                    this.activeCollisions.push(collision)

                } else {

                    // Remove existing collision(s)
                    this.activeCollisions = this.activeCollisions.filter(c => !(
                        (c.colliderHandle1 == colliderID1 && c.colliderHandle2 == colliderID2) ||
                        (c.colliderHandle1 == colliderID2 && c.colliderHandle2 == colliderID1)
                    ))

                }

                // Check if one is the user
                if (object1currentUser || object2currentUser) {

                    // One of them is the user, send event to the other one
                    let object = object1currentUser ? object2 : object1
                    if (object?.didCollideWithUser && started)
                        object.didCollideWithUser()

                }
                
                // Send out a notification hook
                this.hooks.trigger('com.vatom.rapier-physics:onCollisionEvent', {
                    objectID1: object1currentUser ? 'currentuser' : object1?.objectID,
                    objectID2: object2currentUser ? 'currentuser' : object2?.objectID,
                    colliderID1,
                    colliderID2,
                    started
                })

            } catch (err) {

                // This should never happen, but just in case
                console.warn(`[Physics] Error while processing contact force event:`, err)

            }

        })

        // Done, store statistics
        this.frameDuration = Date.now() - startedAt

    }

    /** Update the position of the user's collider */
    async updateUserCollider() {

        // Only do once at a time
        if (this.isUpdatingUserCollider) return
        this.isUpdatingUserCollider = true

        // Catch errors
        try {

            // Get user's position from the main app.
            // TODO: Ideally the main app should have a bridge function to register for position updates on the user...
            // That would be way more efficient than requesting it every frame
            let pos = await this.user.getPosition()

            // Increase height, since our collider is centered in the middle but the user position is at the feet
            pos.y += 1.8 / 2

            // Check if changed
            if (this.oldUserPos?.x == pos.x && this.oldUserPos?.y == pos.y && this.oldUserPos?.z == pos.z) return
            this.oldUserPos = pos

            // Update our collider
            this.userBody.setTranslation(pos)

            // Notify any objects that are touching the current user
            for (let i = 0 ; i < this.physicsObjects.length ; i++) {

                // Notify objects the user is touching
                let object = this.physicsObjects[i]
                if (object.isTouchingCurrentUser)
                    object.didCollideWithUser()

            }

        } catch (err) {

            // Error during update
            console.warn(`[Physics] Error while updating user collider:`, err)

        } finally {

            // Finish updating
            this.isUpdatingUserCollider = false

        }

    }

    /** Get the debug text to show in the debug overlay */
    getDebugText() {

        // Count active physics entities
        let awakeEntities = this.physicsObjects.reduce((prev, current) => prev + (current.body?.isSleeping() === false ? 1 : 0), 0)
        let totalEntities = this.physicsObjects.reduce((prev, current) => prev + (current.body ? 1 : 0), 0)

        // Don't show anything in the debug text if no physics objects registered
        if (totalEntities == 0)
            return null

        // Calculate usage
        let maxTime = 1000/this.simulationFPS
        let percent = Math.round(this.frameDuration / maxTime * 100)

        // Create output
        let result = {
            name: `Physics v${require('../package.json').version} (Rapier v${RAPIER.version()} - time=${Math.floor(this.frameDuration)}ms usage=${percent}%)`,
            text: `awake=${awakeEntities} total=${this.physicsObjects.length} collisions=${this.activeCollisions.length} messages=${this.numMessagesOut}/s▲ ${this.numMessagesIn}/s▼`
        }

        // Reset analytics
        this.numMessagesIn = 0
        this.numMessagesOut = 0

        // Done
        return result

    }

    /** Called when we receive a message from a remote instance of our plugin */
    onMessage(data, fromID) {

        // Update analytics
        this.numMessagesIn += 1

        // Ignore our own messages
        if (data.inst == this.instanceID)
            return

        // Check message type
        if (data.action == 'update') {

            // Get the object this is updating
            let obj = this.physicsObjects.find(o => o.objectID == data.obj)
            if (!obj)
                return

            // Pass it on
            obj.onRemoteUpdateReceived(data)

        }

    }

    /** Called when a remote plugin wants to send an impulse to an object */
    onHookApplyImpulse(data) {

        // Find associated object
        let obj = this.physicsObjects.find(o => o.objectID == data.objectID)
        if (!obj)
            throw new Error("Object not found")

        // Stop if no body
        if (!obj.body)
            throw new Error("Object has no physics body")

        // Stop if not dynamic
        if (obj.mode != 'Dynamic')
            throw new Error("Object is not dynamic")

        // Send impulse
        obj.body.applyImpulse({ x: data.impulse?.x || 0, y: data.impulse?.y || 0, z: data.impulse?.z || 0 }, true)
        obj.sendUpdateNextFrame = true

        // Done
        return true

    }

    /** Fetch the current state of an object */
    onHookGetState(data) {

        // Find associated object
        let obj = this.physicsObjects.find(o => o.objectID == data.objectID)
        if (!obj)
            throw new Error("Object not found")

        // Stop if no body
        if (!obj.body)
            throw new Error("Object has no physics body")

        // Return info
        let translation = obj.body.translation()
        let quaternion = obj.body.rotation()
        let angvel = obj.body.angvel()
        let linvel = obj.body.linvel()
        return {
            counter: obj.syncCounter,
            translation,
            quaternion,
            angvel,
            linvel,
            isSleeping: obj.body.isSleeping()
        }

    }

    /** Set the current state of the object */
    onHookSetState(data) {

        // Find associated object
        let obj = this.physicsObjects.find(o => o.objectID == data.objectID)
        if (!obj)
            throw new Error("Object not found")

        // Stop if no body
        if (!obj.body)
            throw new Error("Object has no physics body")

        // Stop if not dynamic
        if (obj.mode != 'Dynamic')
            throw new Error("Object is not dynamic")

        // Update state
        if (data.angvel) obj.body.setAngvel({ x: data.angvel.x || 0, y: data.angvel.y || 0, z: data.angvel.z || 0 })
        if (data.linvel) obj.body.setLinvel({ x: data.linvel.x || 0, y: data.linvel.y || 0, z: data.linvel.z || 0 })
        obj.sendUpdateNextFrame = true

        // Done
        return true

    }

}

/** Active collision */
class ActiveCollision {

    /** Collider handle 1 */
    colliderHandle1 = 0

    /** Collider handle 2 */
    colliderHandle2 = 0

    /** @type {PhysicsComponent} Object 1 */
    object1 = null

    /** @type {PhysicsComponent} Object 2 */
    object2 = null

}