import RAPIER from '@dimforge/rapier3d-compat'

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

    /** @type {RAPIER.Collider} The object collider */
    collider = null

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
    createPhysics() {

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
        this.type = this.getField('type') || 'Sphere'
        this.synchronized = !!this.getField('synchronized')
        this.mass = Math.max(0.01, parseFloat(this.getField('mass')) || 1)
        this.disableRotation = !!this.getField('disable-rotation')
        this.bounceOnClick = !!this.getField('click-bounce')
        this.syncCounter = 0

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
        this.body = this.world.createRigidBody(desc)

        // Create shape collider
        if (this.type == 'Sphere') {

            // Get ball size
            let sizeX = this.fields.scale_x || 0
            let sizeY = this.fields.scale_y || 0
            let sizeZ = this.fields.scale_z || 0
            let minimumSize = 0.1
            let diameter = Math.max(minimumSize, Math.max(sizeX, Math.max(sizeY, sizeZ)))

            // Create ball collider
            let desc2 = RAPIER.ColliderDesc.ball(diameter / 2)
            this.collider = this.world.createCollider(desc2, this.body)

        } else if (this.type == 'Cube') {

            // Get cube size
            let minimumSize = 0.1
            let sizeX = Math.max(minimumSize, this.fields.scale_x || 0)
            let sizeY = Math.max(minimumSize, this.fields.scale_y || 0)
            let sizeZ = Math.max(minimumSize, this.fields.scale_z || 0)

            // Create ball collider
            let desc2 = RAPIER.ColliderDesc.cuboid(sizeX / 2, sizeY / 2, sizeZ / 2)
            this.collider = this.world.createCollider(desc2, this.body)

        } else if (this.type == 'Cylinder') {

            // Get cube size
            let minimumSize = 0.1
            let sizeX = Math.max(minimumSize, this.fields.scale_x || 0)
            let sizeY = Math.max(minimumSize, this.fields.scale_y || 0)     // <-- Cylinder height
            let sizeZ = Math.max(minimumSize, this.fields.scale_z || 0)
            let diameter = Math.max(sizeX, sizeZ)

            // Create ball collider
            let desc2 = RAPIER.ColliderDesc.cylinder(sizeY / 2, diameter / 2)
            this.collider = this.world.createCollider(desc2, this.body)

        } else {

            // Unknown shape!
            console.warn(`[Physics] Unknown shape type: object=${this.objectID} name=${this.fields.name} type=${this.type}`)
            return

        }

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
        this.collider = null

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
    didCollideWithUser(event) {

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
        if (!this.body || !this.collider)
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
        if (!this.body || !this.collider)
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