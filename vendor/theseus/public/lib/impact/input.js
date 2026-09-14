import ig from './ig.js';

ig.Input = ig.Class.extend({
	bindings: {},
	actions: {},
	presses: {},
	locks: {},
	delayedKeyup: {},
	
	isUsingMouse: false,
	isUsingKeyboard: false,
	isUsingAccelerometer: false,
	mouse: {x: 0, y: 0},
	accel: {x: 0, y: 0, z: 0},
	
	
	initMouse: function() {
		if( this.isUsingMouse ) { return; }
		this.isUsingMouse = true;
		ig.system.canvas.addEventListener('wheel', this.mousewheel.bind(this), false );
		
		ig.system.canvas.addEventListener('contextmenu', this.contextmenu.bind(this), false );
		ig.system.canvas.addEventListener('mousedown', this.keydown.bind(this), false );
		ig.system.canvas.addEventListener('mouseup', this.keyup.bind(this), false );
		ig.system.canvas.addEventListener('mousemove', this.mousemove.bind(this), false );
		
		if( ig.ua.touchDevice ) {
			ig.system.canvas.style.touchAction = 'none';
			ig.system.canvas.addEventListener('touchstart', this.keydown.bind(this), false );
			ig.system.canvas.addEventListener('touchend', this.keyup.bind(this), false );
			ig.system.canvas.addEventListener('touchcancel', this.keyup.bind(this), false );
			ig.system.canvas.addEventListener('touchmove', this.mousemove.bind(this), false );
		}
	},

	
	initKeyboard: function() {
		if( this.isUsingKeyboard ) { return; }
		this.isUsingKeyboard = true;
		window.addEventListener('keydown', this.keydown.bind(this), false );
		window.addEventListener('keyup', this.keyup.bind(this), false );
	},
	
	
	initAccelerometer: function() {
		if( this.isUsingAccelerometer ) { return; }
		this.isUsingAccelerometer = true;
		window.addEventListener('devicemotion', this.devicemotion.bind(this), false );
	},

	
	mouseInputCode: function( event ) {
		if(
			event.type == 'touchstart' ||
			event.type == 'touchend' ||
			event.type == 'touchcancel'
		) {
			return 'MousePrimary';
		}

		switch( event.button ) {
			case 1:
				return 'MouseAuxiliary';
			case 2:
				return 'MouseSecondary';
			case 3:
				return 'MouseBack';
			case 4:
				return 'MouseForward';
			case 0:
			default:
				return 'MousePrimary';
		}
	},


	isMouseInputCode: function( code ) {
		return code == 'MousePrimary' ||
			code == 'MouseSecondary' ||
			code == 'MouseAuxiliary' ||
			code == 'MouseBack' ||
			code == 'MouseForward' ||
			code == 'WheelUp' ||
			code == 'WheelDown';
	},


	mousewheel: function( event ) {
		var code = event.deltaY < 0 ? 'WheelUp' : 'WheelDown';
		var action = this.bindings[code];
		if( action ) {
			this.actions[action] = true;
			this.presses[action] = true;
			this.delayedKeyup[action] = true;
			event.stopPropagation();
			event.preventDefault();
		}
	},
	
	
	mousemove: function( event ) {		
		var internalWidth = ig.system.canvas.offsetWidth || ig.system.realWidth;
		var scale = ig.system.scale * (internalWidth / ig.system.realWidth);
		
		var pos = {left: 0, top: 0};
		if( ig.system.canvas.getBoundingClientRect ) {
			pos = ig.system.canvas.getBoundingClientRect();
		}
		
		var ev = event.touches ? event.touches[0] : event;
		this.mouse.x = (ev.clientX - pos.left) / scale;
		this.mouse.y = (ev.clientY - pos.top) / scale;
	},
	
	
	contextmenu: function( event ) {
		if( this.bindings['MouseSecondary'] ) {
			event.stopPropagation();
			event.preventDefault();
		}
	},
	
	
	keydown: function( event ) {
		var tag = event.target.tagName;
		if( tag == 'INPUT' || tag == 'TEXTAREA' ) { return; }
		
		var code = event.type == 'keydown'
			? event.code
			: this.mouseInputCode( event );
		
		// Focus window element for mouse clicks. Prevents issues when
		// running the game in an iframe.
		if( event.type == 'mousedown' && !ig.ua.mobile ) {
			window.focus();
		}
		
		if( event.type == 'touchstart' || event.type == 'mousedown' ) {
			this.mousemove( event );
		}
			
		var action = this.bindings[code];
		if( action ) {
			this.actions[action] = true;
			if( !this.locks[action] ) {
				this.presses[action] = true;
				this.locks[action] = true;
			}
			event.preventDefault();
		}
	},
	
	
	keyup: function( event ) {
		var tag = event.target.tagName;
		if( tag == 'INPUT' || tag == 'TEXTAREA' ) { return; }
		
		var code = event.type == 'keyup'
			? event.code
			: this.mouseInputCode( event );
		
		var action = this.bindings[code];
		if( action ) {
			this.delayedKeyup[action] = true;
			event.preventDefault();
		}
	},
	
	
	devicemotion: function( event ) {
		this.accel = event.accelerationIncludingGravity;
	},
	
	
	bind: function( key, action ) {
		if( typeof key != 'string' ) {
			throw new TypeError('ig.Input.bind() expects key to be a string');
		}

		if( this.isMouseInputCode( key ) ) { this.initMouse(); }
		else if( /^Gamepad[0-9]+[A-Z]/.test( key ) ) {
			if( !this.initGamepad ) {
				throw new Error('Gamepad plugin is not loaded');
			}

			this.initGamepad();
		}
		else if( key.indexOf('Game' + 'pad') === 0 ) {
			throw new Error(
				'Gamepad bindings must include a controller slot, e.g. Gamepad0Left'
			);
		}
		else { this.initKeyboard(); }

		this.bindings[key] = action;
	},
	
	
	bindTouch: function( selector, action ) {
		var element = ig.$( selector );
		
		var that = this;
		element.addEventListener('touchstart', function(ev) {that.touchStart( ev, action );}, false);
		element.addEventListener('touchend', function(ev) {that.touchEnd( ev, action );}, false);
	},
	
	
	unbind: function( key ) {
		var action = this.bindings[key];
		this.delayedKeyup[action] = true;
		
		this.bindings[key] = null;
	},
	
	
	unbindAll: function() {
		this.bindings = {};
		this.actions = {};
		this.presses = {};
		this.locks = {};
		this.delayedKeyup = {};
	},
	
	
	state: function( action ) {
		return this.actions[action];
	},
	
	
	pressed: function( action ) {
		return this.presses[action];
	},
	
	released: function( action ) {
		return !!this.delayedKeyup[action];
	},
		
	clearPressed: function() {
		for( var action in this.delayedKeyup ) {
			this.actions[action] = false;
			this.locks[action] = false;
		}
		this.delayedKeyup = {};
		this.presses = {};
	},
	
	touchStart: function( event, action ) {
		this.actions[action] = true;
		this.presses[action] = true;
		
		event.stopPropagation();
		event.preventDefault();
		return false;
	},
	
	
	touchEnd: function( event, action ) {
		this.delayedKeyup[action] = true;
		event.stopPropagation();
		event.preventDefault();
		return false;
	}
});
