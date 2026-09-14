import ig from '../impact/impact.js';

const navigatorRef = typeof navigator !== 'undefined' ? navigator : null;
const windowRef = typeof window !== 'undefined' ? window : null;

const GAMEPAD_BUTTON_THRESHOLD = 0.5;
const GAMEPAD_AXIS_DEADZONE = 0.5;

const STANDARD_GAMEPAD_BUTTON_SUFFIXES = [
	['FaceBottom'], // 0
	['FaceRight'], // 1
	['FaceLeft'], // 2
	['FaceTop'], // 3

	['LeftShoulder'], // 4
	['RightShoulder'], // 5
	['LeftTrigger'], // 6
	['RightTrigger'], // 7

	['CenterLeft', 'Select'], // 8
	['CenterRight', 'Start'], // 9

	['LeftStickPress'], // 10
	['RightStickPress'], // 11

	['DpadUp', 'Up'], // 12
	['DpadDown', 'Down'], // 13
	['DpadLeft', 'Left'], // 14
	['DpadRight', 'Right'], // 15

	['Center', 'Home'] // 16
];

if (navigatorRef && navigatorRef.getGamepads) {
	ig.Input.inject({
		isUsingGamepad: false,

		// Gamepad0, Gamepad1, etc. are logical slots, not browser indices.
		maxGamepadSlots: 4,
		gamepadSlots: {},
		gamepadIndexToSlot: {},
		gamepads: {},

		// Auto-assign mode is useful for simple games.
		// Set this to false for a join/rejoin screen.
		gamepadAutoAssign: true,

		// When true, a disconnected slot is not reused by a different device
		// unless it looks like the same controller signature.
		gamepadPreserveDisconnectedSlots: true,

		// Pending join/rejoin requests.
		gamepadJoinRequests: {},
		gamepadJoinButton: 0,

		// Used to avoid repeated joins while the join button is held.
		unassignedJoinButtonStates: {},

		lastGamepadInputStates: {},

		gamepadButtonThreshold: GAMEPAD_BUTTON_THRESHOLD,
		gamepadAxisDeadzone: GAMEPAD_AXIS_DEADZONE,

		// Optional hooks for game UI.
		onGamepadSlotConnected: null,
		onGamepadSlotDisconnected: null,
		onGamepadSlotJoined: null,

		initGamepad: function() {
			if (this.isUsingGamepad) {
				return;
			}

			this.isUsingGamepad = true;

			if (windowRef) {
				windowRef.addEventListener(
					'gamepadconnected',
					this.gamepadconnected.bind(this),
					false
				);

				windowRef.addEventListener(
					'gamepaddisconnected',
					this.gamepaddisconnected.bind(this),
					false
				);
			}

			this.refreshGamepads();
		},

		isGamepadInputCode: function(code) {
			return /^Gamepad[0-9]+[A-Z]/.test(code);
		},

		gamepadconnected: function(event) {
			this.handleGamepadConnected(event.gamepad);
		},

		gamepaddisconnected: function(event) {
			this.handleGamepadDisconnectedByIndex(event.gamepad.index);
		},

		handleGamepadConnected: function(gamepad) {
			if (!gamepad) {
				return;
			}

			this.gamepads[gamepad.index] = gamepad;

			if (this.gamepadAutoAssign) {
				this.assignGamepadAutomatically(gamepad);
			}
		},

		handleGamepadDisconnectedByIndex: function(index) {
			var slot = this.gamepadIndexToSlot[index];

			delete this.gamepads[index];
			delete this.gamepadIndexToSlot[index];
			delete this.unassignedJoinButtonStates[index];

			if (slot === undefined) {
				return;
			}

			slot = Number(slot);

			var slotState = this.gamepadSlots[slot];

			if (slotState) {
				slotState.index = null;
				slotState.connected = false;
				slotState.disconnectedAt = Date.now();
			}

			this.releaseGamepadSlot(slot);

			if (this.onGamepadSlotDisconnected) {
				this.onGamepadSlotDisconnected(slot, slotState);
			}
		},

		refreshGamepads: function() {
			var visibleIndexes = {};
			var gamepads = navigatorRef.getGamepads() || [];

			for (var i = 0; i < gamepads.length; i++) {
				var gamepad = gamepads[i];

				if (!gamepad || gamepad.connected === false) {
					continue;
				}

				visibleIndexes[gamepad.index] = true;
				this.gamepads[gamepad.index] = gamepad;

				if (
					this.gamepadAutoAssign &&
					this.gamepadIndexToSlot[gamepad.index] === undefined
				) {
					this.assignGamepadAutomatically(gamepad);
				}
			}

			for (var index in this.gamepads) {
				if (!visibleIndexes[index]) {
					this.handleGamepadDisconnectedByIndex(index);
				}
			}
		},

		gamepadSignature: function(gamepad) {
			return [
				gamepad.id,
				gamepad.mapping,
				gamepad.buttons ? gamepad.buttons.length : 0,
				gamepad.axes ? gamepad.axes.length : 0
			].join('|');
		},

		findDisconnectedSlotBySignature: function(signature) {
			for (var i = 0; i < this.maxGamepadSlots; i++) {
				var slotState = this.gamepadSlots[i];

				if (
					slotState &&
					!slotState.connected &&
					slotState.signature == signature
				) {
					return i;
				}
			}

			return null;
		},

		findOpenGamepadSlot: function(allowDisconnectedReuse) {
			for (var i = 0; i < this.maxGamepadSlots; i++) {
				var slotState = this.gamepadSlots[i];

				if (!slotState) {
					return i;
				}

				if (allowDisconnectedReuse && !slotState.connected) {
					return i;
				}
			}

			return null;
		},

		assignGamepadAutomatically: function(gamepad) {
			if (this.gamepadIndexToSlot[gamepad.index] !== undefined) {
				return this.gamepadIndexToSlot[gamepad.index];
			}

			var signature = this.gamepadSignature(gamepad);
			var slot = this.findDisconnectedSlotBySignature(signature);

			if (slot === null) {
				slot = this.findOpenGamepadSlot(!this.gamepadPreserveDisconnectedSlots);
			}

			if (slot === null) {
				return null;
			}

			this.assignGamepadToSlot(gamepad, slot, false, false);
			return slot;
		},

		assignGamepadToSlot: function(
			gamepad,
			slot,
			joinedByUser,
			ignoreUntilReleased
		) {
			slot = Number(slot);

			if (slot < 0 || slot >= this.maxGamepadSlots) {
				return false;
			}

			var currentSlot = this.gamepadIndexToSlot[gamepad.index];

			if (currentSlot !== undefined && Number(currentSlot) !== slot) {
				return false;
			}

			var existingSlotState = this.gamepadSlots[slot];

			if (
				existingSlotState &&
				existingSlotState.connected &&
				existingSlotState.index !== gamepad.index
			) {
				return false;
			}

			this.gamepadSlots[slot] = {
				index: gamepad.index,
				signature: this.gamepadSignature(gamepad),
				connected: true,
				joined: !!joinedByUser || !!(existingSlotState && existingSlotState.joined),
				disconnectedAt: null,

				// For join/rejoin screens:
				// prevents "press A to join" from also triggering jump/shoot
				// on the same frame.
				ignoreUntilReleased: !!ignoreUntilReleased
			};

			this.gamepadIndexToSlot[gamepad.index] = slot;
			this.gamepads[gamepad.index] = gamepad;

			delete this.gamepadJoinRequests[slot];
			delete this.unassignedJoinButtonStates[gamepad.index];

			if (this.onGamepadSlotConnected) {
				this.onGamepadSlotConnected(slot, gamepad, this.gamepadSlots[slot]);
			}

			if (joinedByUser && this.onGamepadSlotJoined) {
				this.onGamepadSlotJoined(slot, gamepad, this.gamepadSlots[slot]);
			}

			return true;
		},

		requestGamepadJoin: function(slot) {
			slot = Number(slot);

			if (slot < 0 || slot >= this.maxGamepadSlots) {
				return false;
			}

			var slotState = this.gamepadSlots[slot];

			if (slotState && slotState.connected) {
				return false;
			}

			this.initGamepad();
			this.gamepadJoinRequests[slot] = true;

			return true;
		},

		cancelGamepadJoin: function(slot) {
			delete this.gamepadJoinRequests[Number(slot)];
		},

		forgetGamepadSlot: function(slot) {
			slot = Number(slot);

			var slotState = this.gamepadSlots[slot];

			if (!slotState) {
				return;
			}

			if (slotState.index !== null && slotState.index !== undefined) {
				delete this.gamepadIndexToSlot[slotState.index];
			}

			this.releaseGamepadSlot(slot);
			delete this.gamepadSlots[slot];
			delete this.gamepadJoinRequests[slot];
		},

		getFirstRequestedGamepadSlot: function() {
			for (var i = 0; i < this.maxGamepadSlots; i++) {
				if (!this.gamepadJoinRequests[i]) {
					continue;
				}

				var slotState = this.gamepadSlots[i];

				if (!slotState || !slotState.connected) {
					return i;
				}
			}

			return null;
		},

		pollGamepadJoinRequests: function() {
			var requestedSlot = this.getFirstRequestedGamepadSlot();

			if (requestedSlot === null) {
				return;
			}

			var gamepads = navigatorRef.getGamepads() || [];

			for (var i = 0; i < gamepads.length; i++) {
				var gamepad = gamepads[i];

				if (!gamepad || gamepad.connected === false) {
					continue;
				}

				if (this.gamepadIndexToSlot[gamepad.index] !== undefined) {
					continue;
				}

				var button = gamepad.buttons[this.gamepadJoinButton];
				var pressed = this.isGamepadButtonPressed(button);
				var wasPressed = this.unassignedJoinButtonStates[gamepad.index];

				this.unassignedJoinButtonStates[gamepad.index] = pressed;

				// Rising edge only: press, not hold.
				if (pressed && !wasPressed) {
					this.assignGamepadToSlot(
						gamepad,
						requestedSlot,
						true,
						true
					);

					return;
				}
			}
		},

		gamepadInputCode: function(slot, suffix) {
			return 'Game' + 'pad' + slot + suffix;
		},

		addGamepadInputCode: function(states, slot, suffix) {
			states[this.gamepadInputCode(slot, suffix)] = true;
		},

		addGamepadInputCodes: function(states, slot, suffixes) {
			if (!suffixes) {
				return;
			}

			for (var i = 0; i < suffixes.length; i++) {
				this.addGamepadInputCode(states, slot, suffixes[i]);
			}
		},

		isGamepadButtonPressed: function(button) {
			if (!button) {
				return false;
			}

			if (typeof button == 'object') {
				return button.pressed ||
					button.value >= this.gamepadButtonThreshold;
			}

			return button >= this.gamepadButtonThreshold;
		},

		hasActiveGamepadInput: function(gamepad) {
			var buttons = gamepad.buttons || [];
			var axes = gamepad.axes || [];
			var deadzone = this.gamepadAxisDeadzone;

			for (var i = 0; i < buttons.length; i++) {
				if (this.isGamepadButtonPressed(buttons[i])) {
					return true;
				}
			}

			for (var a = 0; a < axes.length; a++) {
				if (Math.abs(axes[a] || 0) >= deadzone) {
					return true;
				}
			}

			return false;
		},

		pollGamepadButtons: function(gamepad, slot, states) {
			var buttons = gamepad.buttons || [];
			var isStandard = gamepad.mapping == 'standard';

			for (var i = 0; i < buttons.length; i++) {
				if (!this.isGamepadButtonPressed(buttons[i])) {
					continue;
				}

				// Raw fallback.
				// Example: Gamepad0Button0
				this.addGamepadInputCode(states, slot, 'Button' + i);

				// Semantic names only when the browser says this is standard-mapped.
				// Example: Gamepad0FaceBottom
				if (isStandard) {
					this.addGamepadInputCodes(
						states,
						slot,
						STANDARD_GAMEPAD_BUTTON_SUFFIXES[i]
					);
				}
			}
		},

		pollGamepadAxes: function(gamepad, slot, states) {
			var axes = gamepad.axes || [];
			var deadzone = this.gamepadAxisDeadzone;
			var isStandard = gamepad.mapping == 'standard';

			for (var i = 0; i < axes.length; i++) {
				var value = axes[i] || 0;

				if (value <= -deadzone) {
					this.addGamepadInputCode(
						states,
						slot,
						'Axis' + i + 'Negative'
					);
				}
				else if (value >= deadzone) {
					this.addGamepadInputCode(
						states,
						slot,
						'Axis' + i + 'Positive'
					);
				}
			}

			if (!isStandard) {
				return;
			}

			// Standard Gamepad axes:
			// 0: left stick horizontal, negative left / positive right
			// 1: left stick vertical, negative up / positive down
			// 2: right stick horizontal, negative left / positive right
			// 3: right stick vertical, negative up / positive down

			if (axes[0] <= -deadzone) {
				this.addGamepadInputCode(states, slot, 'LeftStickLeft');
				this.addGamepadInputCode(states, slot, 'Left');
			}
			else if (axes[0] >= deadzone) {
				this.addGamepadInputCode(states, slot, 'LeftStickRight');
				this.addGamepadInputCode(states, slot, 'Right');
			}

			if (axes[1] <= -deadzone) {
				this.addGamepadInputCode(states, slot, 'LeftStickUp');
				this.addGamepadInputCode(states, slot, 'Up');
			}
			else if (axes[1] >= deadzone) {
				this.addGamepadInputCode(states, slot, 'LeftStickDown');
				this.addGamepadInputCode(states, slot, 'Down');
			}

			if (axes[2] <= -deadzone) {
				this.addGamepadInputCode(states, slot, 'RightStickLeft');
			}
			else if (axes[2] >= deadzone) {
				this.addGamepadInputCode(states, slot, 'RightStickRight');
			}

			if (axes[3] <= -deadzone) {
				this.addGamepadInputCode(states, slot, 'RightStickUp');
			}
			else if (axes[3] >= deadzone) {
				this.addGamepadInputCode(states, slot, 'RightStickDown');
			}
		},

		updateGamepadInputCode: function(code, isDown) {
			var action = this.bindings[code];

			if (!action) {
				return;
			}

			if (isDown) {
				this.actions[action] = true;

				if (!this.locks[action]) {
					this.presses[action] = true;
					this.locks[action] = true;
				}
			}
			else {
				this.delayedKeyup[action] = true;
			}
		},

		releaseGamepadInputCode: function(code) {
			var action = this.bindings[code];

			if (action) {
				this.delayedKeyup[action] = true;
			}
		},

		releaseGamepadSlot: function(slot) {
			var pattern = new RegExp('^Gamepad' + slot + '(?=[A-Z])');

			for (var code in this.lastGamepadInputStates) {
				if (pattern.test(code)) {
					this.releaseGamepadInputCode(code);
					delete this.lastGamepadInputStates[code];
				}
			}
		},

		pollGamepad: function() {
			if (!this.isUsingGamepad) {
				return;
			}

			this.refreshGamepads();
			this.pollGamepadJoinRequests();

			var currentStates = {};
			var previousStates = this.lastGamepadInputStates;

			for (var index in this.gamepads) {
				var gamepad = this.gamepads[index];

				if (!gamepad || gamepad.connected === false) {
					continue;
				}

				var slot = this.gamepadIndexToSlot[gamepad.index];

				if (slot === undefined) {
					continue;
				}

				slot = Number(slot);

				var slotState = this.gamepadSlots[slot];

				if (!slotState || !slotState.connected) {
					continue;
				}

				if (slotState.ignoreUntilReleased) {
					if (!this.hasActiveGamepadInput(gamepad)) {
						slotState.ignoreUntilReleased = false;
					}

					continue;
				}

				this.pollGamepadButtons(gamepad, slot, currentStates);
				this.pollGamepadAxes(gamepad, slot, currentStates);
			}

			for (var downCode in currentStates) {
				this.updateGamepadInputCode(downCode, true);
			}

			for (var previousCode in previousStates) {
				if (!currentStates[previousCode]) {
					this.updateGamepadInputCode(previousCode, false);
				}
			}

			this.lastGamepadInputStates = currentStates;
		}
	});

	ig.Game.inject({
		run: function() {
			ig.input.pollGamepad();
			this.parent();
		}
	});
}
