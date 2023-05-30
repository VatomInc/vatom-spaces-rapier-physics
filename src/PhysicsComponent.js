import RAPIER from '@dimforge/rapier3d-compat'
import { BaseComponent } from 'vatom-spaces-plugins'

/**
 * Physics component for a single object.
 */
export default class PhysicsComponent extends BaseComponent {

    /** @type {RAPIER.World} Reference to the main physics world */
    get world() {
        return this.plugin.world
    }

    /** @type {RAPIER.RigidBody} The object body */
    body = null

    /** Created colliders */
    colliders = []

    /** The mode we are operating in, set in the Editor */
    mode = 'Static'

    /** The type of collision, set in the Editor */
    type = 'Sphere'

    /** The weight of the object in kilograms, set in the Editor */
    mass = 1

    /** True if rotation should be disabled, set in the Editor */
    disableRotation = false

    /** True if the object should bounce on click, set in the Editor */
    bounceOnClick = false

    /** 
     * This is used to determine which incoming object updates to accept. The highest number wins. This is
     * incremented every time we send object updates out to the network, which we only do when our user is
     * responsible for a physics change, such as walking into an object or clicking it to make it bounce, etc...
     */
    syncCounter = 0

    /** If true, we should send a network update of this object on the next frame */
    sendUpdateNextFrame = false

    /** True if the object is currently touching the current user */
    get isTouchingCurrentUser() {
        return !!this.plugin.activeCollisions.find(c => (
            (c.colliderHandle1 == this.plugin.userCollider.handle && c.object2 == this) ||
            (c.colliderHandle2 == this.plugin.userCollider.handle && c.object1 == this)
        ))
    }

    /** Register this component */
    static register(plugin) {

        // Register it
        plugin.objects.registerComponent(this, {
            id: 'collider',
            name: 'Physics',
            description: 'Add physics properties to this object',
            settings: [
                { type: 'checkbox', id: 'enabled', name: 'Enabled', help: "If not enabled, this object will not have any physics applied." },
                { type: 'checkbox', id: 'synchronized', name: 'Synchronized', help: "If enabled, physics updates will be sent to all nearby users. All users will then see the object move in the same way. If disabled, the object moves independently for each user." },
                { type: 'select', id: 'mode', name: 'Mode', default: 'Static', values: ["Static", "Dynamic", "Kinematic"], help: "Select the mode of operation for this physics object. Static objects do not ever move, dynamic objects are moved by the physics engine, and kinematic objects are moved externally (ie elevators, moving platforms, etc)." },
                { type: 'select', id: 'type', name: 'Shape type', default: 'Automatic', values: ['Automatic', 'Sphere', 'Cube', 'Cylinder', 'Convex Hull', 'Trimesh'], help: "Select the shape of the physics entity to attach to this object.<br><br><ul style='text-align: left; '> <li><b>Automatic:</b> Attempts to detect the shape type automatically.</li> <li><b>Sphere, Cube, Cylinder:</b> These are standard shape types and are the easiest on performance.</li> <li><b>Convex Hull:</b> Creates a closed, optimized shape around the mesh to use for collision.</li> <li><b>Trimesh:</b> Uses every triangle of the mesh directly for collision. This is the most accurate, but is heavy on performance.</li> </ul>" },
                { type: 'number', id: 'mass', name: 'Mass (KG)', default: 1, help: "The weight of the object in kilograms. Defaults to 1kg." },
                { type: 'checkbox', id: 'disable-rotation', name: 'Prevent rotation', help: "If enabled, the object will not rotate but can still be pushed around." },
                { type: 'checkbox', id: 'click-bounce', name: 'Bounce on Click', help: "If enabled, clicking this object will cause it to bounce in the air briefly." },
            ]
        })

    }

    /** Called on load */
    onLoad() {

        // Add to physics list
        this.plugin.physicsObjects.push(this)

        // Create physics object
        this.createPhysics()

    }

    /** Called on unload */
    onUnload() {

        // Remove from physics list
        this.plugin.physicsObjects = this.plugin.physicsObjects.filter(p => p != this)

        // Remove physics
        this.removePhysics()

    }

    /** Called when the object is updated on the server */
    onObjectUpdated() {

        // Reload physics for this object
        this.createPhysics()

    }

    /** (Re)create the physics collider for this object */
    async createPhysics() {

        // Remove previous physics if any
        this.removePhysics()

        // Check if enabled
        if (!this.getField('enabled'))
            return

        // We currently don't support parented objects
        if (this.fields.parent)
            return console.warn(`[Physics] We don't currently support physics on parented objects: object=${this.objectID} name=${this.fields.name}`)

        // Get properties from the Editor
        this.mode = this.getField('mode') || 'Static'
        this.type = this.getField('type') || 'Automatic'
        this.synchronized = !!this.getField('synchronized')
        this.mass = Math.max(0.01, parseFloat(this.getField('mass')) || 1)
        this.disableRotation = !!this.getField('disable-rotation')
        this.bounceOnClick = !!this.getField('click-bounce')
        this.syncCounter = 0

        // If type is automatic, try to detect it from the object type
        if (this.type == 'Automatic' && this.fields.type == 'cylinder')     this.type = 'Cylinder'
        else if (this.type == 'Automatic' && this.fields.type == 'cube')    this.type = 'Cube'
        else if (this.type == 'Automatic' && this.fields.type == 'sphere')  this.type = 'Sphere'
        else if (this.type == 'Automatic' && this.mode == 'Static')         this.type = 'Trimesh'       // <-- If not moving, we can use the more expensive Trimesh mode (allows for holes)
        else if (this.type == 'Automatic')                                  this.type = 'Convex Hull'   // <-- If moving, we must use the cheaper Convex Hull mode (no holes)

        // Create physics rigidbody description
        console.debug(`[Physics] Creating physics entity: object=${this.objectID} name=${this.fields.name} mode=${this.mode} type=${this.type} sync=${this.synchronized}`)

        // Check which mode to operate in
        let desc = null
        if (this.mode == 'Static') {
            
            // Create a dynamic body
            desc = RAPIER.RigidBodyDesc.fixed()

        } else if (this.mode == 'Dynamic') {
            
            // Create a dynamic body
            desc = RAPIER.RigidBodyDesc.dynamic()

            // Set object mass, since we're not adding weight to the colliders
            desc.setAdditionalMass(this.mass)

        } else {

            // Unknown mode!
            console.warn(`[Physics] Unknown mode: object=${this.objectID} name=${this.fields.name} mode=${this.mode}`)
            return

        }

        // Set it's initial position
        desc.setTranslation(this.fields.x, this.fields.height || 0, this.fields.y)

        // Set rotation if we have it
        if (this.fields.quatX || this.fields.quatY || this.fields.quatZ || this.fields.quatW)
            desc.setRotation({ x: this.fields.quatX || 0, y: this.fields.quatY || 0, z: this.fields.quatZ || 0, w: this.fields.quatW || 0 })

        // Lock rotation if requested
        if (this.disableRotation)
            desc.lockRotations()

        // Create body
        let body = this.world.createRigidBody(desc)
        let colliders = []

        // Create shape collider
        if (this.type == 'Sphere') {

            // Get ball size
            let sizeUniform = this.fields.scale || 1
            let sizeX = 0.5 * (this.fields.scale_x || 1) * sizeUniform
            let sizeY = 0.5 * (this.fields.scale_y || 1) * sizeUniform
            let sizeZ = 0.5 * (this.fields.scale_z || 1) * sizeUniform
            let radius = Math.max(sizeX, Math.max(sizeY, sizeZ))

            // Create ball collider
            let desc2 = RAPIER.ColliderDesc.ball(radius)
            let collider = this.world.createCollider(desc2, body)
            colliders.push(collider)

        } else if (this.type == 'Cube') {

            // Get cube size
            let sizeUniform = this.fields.scale || 1
            let sizeX = 1 * (this.fields.scale_x || 1) * sizeUniform
            let sizeY = 1 * (this.fields.scale_y || 1) * sizeUniform
            let sizeZ = 1 * (this.fields.scale_z || 1) * sizeUniform

            // Create ball collider
            let desc2 = RAPIER.ColliderDesc.cuboid(sizeX / 2, sizeY / 2, sizeZ / 2)
            let collider = this.world.createCollider(desc2, body)
            colliders.push(collider)

        } else if (this.type == 'Cylinder') {

            // Get cube size
            let sizeUniform = this.fields.scale || 1
            let sizeX = 0.5 * (this.fields.scale_x || 1) * sizeUniform
            let sizeY = 1.0 * (this.fields.scale_y || 1) * sizeUniform    // <-- Cylinder height
            let sizeZ = 0.5 * (this.fields.scale_z || 1) * sizeUniform
            let radius = Math.max(sizeX, sizeZ)

            // Create ball collider
            let desc2 = RAPIER.ColliderDesc.cylinder(sizeY / 2, radius)
            let collider = this.world.createCollider(desc2, body)
            colliders.push(collider)

        } else if (this.type == 'Convex Hull') {

            // Get vertex points
            let objects = await this.plugin.objects.getVertices(this.objectID)

            // Get scale value
            let scaleUniform = this.fields.scale || 1
            let scaleX = (this.fields.scale_x || 1) * scaleUniform
            let scaleY = (this.fields.scale_y || 1) * scaleUniform
            let scaleZ = (this.fields.scale_z || 1) * scaleUniform

            // Create convex hulls
            for (let obj of objects) {

                // Apply scale to vertices
                for (let i = 0 ; i < obj.vertices.length ; i += 3) {
                    obj.vertices[i + 0] *= scaleX
                    obj.vertices[i + 1] *= scaleY
                    obj.vertices[i + 2] *= scaleZ
                }

                // Create it
                let desc2 = RAPIER.ColliderDesc.convexHull(obj.vertices)
                let collider = this.world.createCollider(desc2, body)
                colliders.push(collider)

            }

        } else if (this.type == 'Trimesh') {

            // Get vertex points
            let objects = await this.plugin.objects.getVertices(this.objectID)

            // Get scale value
            let scaleUniform = this.fields.scale || 1
            let scaleX = (this.fields.scale_x || 1) * scaleUniform
            let scaleY = (this.fields.scale_y || 1) * scaleUniform
            let scaleZ = (this.fields.scale_z || 1) * scaleUniform

            // Create convex hulls
            for (let obj of objects) {

                // Apply scale to vertices
                for (let i = 0 ; i < obj.vertices.length ; i += 3) {
                    obj.vertices[i + 0] *= scaleX
                    obj.vertices[i + 1] *= scaleY
                    obj.vertices[i + 2] *= scaleZ
                }

                // Create it
                let desc2 = RAPIER.ColliderDesc.trimesh(obj.vertices, obj.indices)
                let collider = this.world.createCollider(desc2, body)
                colliders.push(collider)

            }

        } else {

            // Unknown shape! Create a generic cube
            console.warn(`[Physics] Unknown shape type: object=${this.objectID} name=${this.fields.name} type=${this.type}`)
            let desc2 = RAPIER.ColliderDesc.cuboid(1, 1, 1)
            let collider = this.world.createCollider(desc2, body)
            colliders.push(collider)

        }

        // Enable collision events
        for (let collider of colliders)
            collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)

        // Done
        this.body = body
        this.colliders = colliders

    }

    /** Remove physics for this object */
    removePhysics() {

        // Stop if no physics registered
        if (!this.body)
            return

        // Remove the body
        console.debug(`[Physics] Removing physics entity: object=${this.objectID} name=${this.fields.name}`)
        this.world.removeRigidBody(this.body)
        this.body = null
        this.colliders = []

    }

    /** Called on every physics frame */
    loop() {

        // Stop if not loaded
        if (!this.body)
            return

        // Stop if object is asleep
        if (this.body.isSleeping())
            return

        // Stop if not a dynamic object, since only dynamic objects are moved via the physics engine
        if (this.mode != 'Dynamic')
            return

        // Send new object state to the app, ensure it's a local-only update
        let translation = this.body.translation()
        let quat = this.body.rotation()
        this.plugin.objects.update(this.objectID, {

            // New position
            x: translation.x,
            height: translation.y,
            y: translation.z,

            // New rotation
            quatX: quat.x,
            quatY: quat.y,
            quatZ: quat.z,
            quatW: quat.w,

        }, true)

        // Catch objects that fall out of the world
        if (translation.y <= -50) {

            // Reset this object's position
            console.warn(`[Physics] Object fell out of the world: object=${this.objectID} name=${this.fields.name}`)
            this.fields.height = 10
            this.plugin.objects.update(this.objectID, { height: 10 }, true)

            // Reload the physics entity
            this.createPhysics()
            return

        }

        // Send network update if needed
        if (this.sendUpdateNextFrame) {
            this.sendUpdate()
        }

    }

    /** Called when the user clicks on the object */
    onClick() {

        // Stop if not loaded
        if (!this.body)
            return

        // Stop if bounce on click is not enabled
        if (!this.bounceOnClick)
            return

        // Stop if not a dynamic object, since only dynamic objects are moved via the physics engine
        if (this.mode != 'Dynamic')
            return

        // Apply an impulse to the object
        this.body.applyImpulse({ x: 0, y: 20, z: 0 }, true)
        this.sendUpdate()

    }

    /** Called when we detect that the user has collided with this object */
    didCollideWithUser() {

        // Send update out to the network on the next frame, once velocities etc have been calculated
        this.sendUpdateNextFrame = true

    }

    /** Send a physics update to the network */
    sendUpdate() {

        // NOTE: The logic here is that every "incident" from this user that causes the physics to change in a client-specific way,
        // such as pushing an object or making it bounce etc, is sent to the network, and nothing else. This means physics does not
        // send network updates continuously at all, and only sends updates when the current user modifies the physics state directly...
        //
        // In theory this should result in very few network messages going out, which also means it should be safe to broadcast to the
        // entire server...
        //
        // To handle conflicts, we simply use the messages with the latest sync counter. When an update is received, we either ignore it
        // if the counter is below ours, or update our counter to match the message and update the object. This may result in some strange
        // visuals though if two users are pushing an object at the same time...

        // Stop if not loaded
        if (!this.body)
            return

        // Stop if not in synchronized mode
        if (!this.synchronized)
            return

        // Stop if not a dynamic object, since only dynamic objects are moved via the physics engine
        if (this.mode != 'Dynamic')
            return

        // Stop if sending too quickly
        let now = Date.now()
        if (this.lastUpdateSent && now - this.lastUpdateSent < 100) return
        this.lastUpdateSent = now

        // Increment our counter and send the update
        this.sendUpdateNextFrame = false
        this.syncCounter += 1
        // console.debug(`[Physics] Sending object update: counter=${this.syncCounter} object=${this.objectID} name=${this.fields.name}`)
        let translation = this.body.translation()
        let quat = this.body.rotation()
        let angvel = this.body.angvel()
        let linvel = this.body.linvel()
        this.plugin.messages.send({
            action: 'update',
            inst: this.plugin.instanceID,
            obj: this.objectID,
            counter: this.syncCounter,
            pos: [translation.x, translation.y, translation.z],
            quat: [quat.x, quat.y, quat.z, quat.w],
            angvel: [angvel.x, angvel.y, angvel.z],
            linvel: [linvel.x, linvel.y, linvel.z]
        }, true)

        // Update analytics
        this.plugin.numMessagesOut += 1

    }

    /** Called when we receive an object update from a remote user */
    onRemoteUpdateReceived(data) {

        // Stop if not loaded
        if (!this.body)
            return

        // Stop if not in synchronized mode
        if (!this.synchronized)
            return

        // Ignore if our counter is higher
        if (data.counter < this.syncCounter)
            return

        // Stop if not a dynamic object, since only dynamic objects are moved via the physics engine
        if (this.mode != 'Dynamic')
            return

        // Apply remote state to our object
        this.syncCounter = data.counter
        this.body.setTranslation({ x: data.pos[0], y: data.pos[1], z: data.pos[2] })
        this.body.setRotation({ x: data.quat[0], y: data.quat[1], z: data.quat[2], w: data.quat[3] })
        this.body.setAngvel({ x: data.angvel[0], y: data.angvel[1], z: data.angvel[2] })
        this.body.setLinvel({ x: data.linvel[0], y: data.linvel[1], z: data.linvel[2] })

        // Wake up the object
        this.body.wakeUp()

    }

}