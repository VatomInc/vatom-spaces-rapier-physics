import RAPIER from '@dimforge/rapier3d-compat'
import PhysicsComponent from './PhysicsComponent'

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
        this.userCollider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)

        // Event collector
        this.eventQueue = new RAPIER.EventQueue(true)

        // Ignore very tiny collisions
        this.userCollider.setContactForceEventThreshold(0.0001)

        // Start game loop
        setInterval(this.loop.bind(this), 1000/this.simulationFPS)

        // Register component
        PhysicsComponent.register(this)

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
        this.eventQueue.drainContactForceEvents(event => {

            // Get colliders that were affected
            let handle1 = event.collider1(); // Handle of the first collider involved in the event.
            let handle2 = event.collider2(); // Handle of the second collider involved in the event.

            // Ensure one of them is the current user, and get the other one
            let handle = null
            if (handle1 == this.userCollider.handle && handle2 != this.userCollider.handle) {
                handle = handle2
            } else if (handle1 != this.userCollider.handle && handle2 == this.userCollider.handle) {
                handle = handle1
            } else {

                // Two objects are colliding unrelated to the current user, we don't care about these
                return

            }

            // Get the object that has this handle
            let object = this.physicsObjects.find(o => o.collider.handle == handle)
            if (!object)
                return

            // Pass it on
            object.didCollideWithUser(event)

        })

        // Done, store statistics
        this.frameDuration = Date.now() - startedAt

    }

    /** Update the position of the user's collider */
    updateUserCollider() {

        // Only do once at a time
        if (this.isUpdatingUserCollider) return
        this.isUpdatingUserCollider = true

        // Get user's position from the main app.
        // TODO: Ideally the main app should have a bridge function to register for position updates on the user...
        // That would be way more efficient than requesting it every frame
        this.user.getPosition().then(pos => {

            // Increase height, since our collider is centered in the middle but the user position is at the feet
            pos.y += 1.8 / 2

            // Update our collider
            this.userBody.setTranslation(pos)
            this.isUpdatingUserCollider = false

        }).catch(err => {

            // Silently ignore errors, this should never error
            this.isUpdatingUserCollider = false

        })

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
            name: `Physics (Rapier v${RAPIER.version()} - time=${Math.floor(this.frameDuration)}ms usage=${percent}%)`,
            text: `awake=${awakeEntities} total=${this.physicsObjects.length} messages=${this.numMessagesOut}/s▲ ${this.numMessagesIn}/s▼`
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

}
