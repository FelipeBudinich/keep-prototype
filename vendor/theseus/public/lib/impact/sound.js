import ig from './ig.js';

const globalScope = typeof window !== 'undefined' ? window : globalThis;

const normalizePath = function( path ) {
	return (path || '').replace(/^\.\//, '').replace(/\\/g, '/');
};

const appendCacheSuffix = function( url ) {
	if( !ig.nocache ) {
		return url;
	}

	return url + (url.indexOf('?') === -1 ? ig.nocache : '&' + ig.nocache.slice(1));
};

const getSfxAtlasManifest = function() {
	return globalScope.__THESEUS_SFX_ATLAS_MANIFEST__ || null;
};

const getSfxAtlasEntry = function( path ) {
	var manifest = getSfxAtlasManifest();
	if( !manifest || !manifest.sounds ) {
		return null;
	}

	var normalizedPath = normalizePath( path );
	var entry = manifest.sounds[normalizedPath];
	if( entry ) {
		return entry;
	}

	return manifest.sounds[normalizedPath.replace(/\.[^/.]*$/, '.*')] || null;
};

const getSfxAtlasDefinition = function( atlasIndex ) {
	var manifest = getSfxAtlasManifest();
	if( !manifest || !manifest.atlases || !manifest.atlases[atlasIndex] ) {
		return null;
	}

	return manifest.atlases[atlasIndex];
};

const getMusicAtlasManifest = function() {
	return globalScope.__THESEUS_MUSIC_ATLAS_MANIFEST__ || null;
};

const getMusicAtlasEntry = function( path ) {
	var manifest = getMusicAtlasManifest();
	if( !manifest || !manifest.tracks ) {
		return null;
	}

	var normalizedPath = normalizePath( path );
	var entry = manifest.tracks[normalizedPath];
	if( entry ) {
		return entry;
	}

	return manifest.tracks[normalizedPath.replace(/\.[^/.]*$/, '.*')] || null;
};

const getMusicAtlasDefinition = function( atlasIndex ) {
	var manifest = getMusicAtlasManifest();
	if( !manifest || !manifest.atlases || !manifest.atlases[atlasIndex] ) {
		return null;
	}

	return manifest.atlases[atlasIndex];
};

ig.SoundManager = ig.Class.extend({
	clips: {},
	sfxAtlasCache: {},
	volume: 1,
	format: null,
	
	init: function() {
		this.sfxAtlasCache = {};

		// Quick sanity check if the Browser supports the Audio tag
		if( !ig.Sound.enabled || !window.Audio ) {
			ig.Sound.enabled = false;
			return;
		}
		
		// Probe sound formats and determine the file extension to load
		var probe = new Audio();
		for( var i = 0; i < ig.Sound.use.length; i++ ) {
			var format = ig.Sound.use[i];
			if( probe.canPlayType(format.mime) ) {
				this.format = format;
				break;
			}
		}
		
		// No compatible format found? -> Disable sound
		if( !this.format ) {
			ig.Sound.enabled = false;
		}

		// Create WebAudio Context
		if( ig.Sound.enabled && ig.Sound.useWebAudio ) {
			this.audioContext = new AudioContext();
			this.boundWebAudioUnlock = this.unlockWebAudio.bind(this);
			ig.system.canvas.addEventListener('touchstart', this.boundWebAudioUnlock, false);
			ig.system.canvas.addEventListener('mousedown', this.boundWebAudioUnlock, false);
		}
	},
	
	unlockWebAudio: function() {
		ig.system.canvas.removeEventListener('touchstart', this.boundWebAudioUnlock, false);
		ig.system.canvas.removeEventListener('mousedown', this.boundWebAudioUnlock, false);
		
		// create empty buffer
		var buffer = this.audioContext.createBuffer(1, 1, 22050);
		var source = this.audioContext.createBufferSource();
		source.buffer = buffer;

		source.connect(this.audioContext.destination);
		source.start(0);
	},

	load: function( path, multiChannel, loadCallback ) {
		if( multiChannel && ig.Sound.useWebAudio ) {
			// Requested as Multichannel and we're using WebAudio?
			var sfxAtlasEntry = this.getSfxAtlasEntry( path );
			if( sfxAtlasEntry ) {
				return this.loadSfxAtlasWebAudio( path, sfxAtlasEntry, loadCallback );
			}

			return this.loadWebAudio( path, multiChannel, loadCallback );
		}

		if( !multiChannel ) {
			var musicAtlasEntry = this.getMusicAtlasEntry( path );
			if( musicAtlasEntry ) {
				return this.loadMusicAtlasHTML5( path, musicAtlasEntry, loadCallback );
			}
		}

		// Oldschool HTML5 Audio - always used for Music
		return this.loadHTML5Audio( path, multiChannel, loadCallback );
	},

	getSfxAtlasEntry: function( path ) {
		return getSfxAtlasEntry( path );
	},

	getMusicAtlasEntry: function( path ) {
		return getMusicAtlasEntry( path );
	},

	loadWebAudio: function( path, multiChannel, loadCallback ) {
		// Path to the soundfile with the right extension (.ogg or .mp3)
		var realPath = ig.prefix + path.replace(/[^\.]+$/, this.format.ext) + ig.nocache;

		if( this.clips[path] ) {
			return this.clips[path];
		}

		var audioSource = new ig.Sound.WebAudioSource();
		this.clips[path] = audioSource;

		var request = new XMLHttpRequest();
		request.open('GET', realPath, true);
		request.responseType = 'arraybuffer';


		var that = this;
		request.onload = function(ev) {
			that.audioContext.decodeAudioData(request.response, 
				function(buffer) {
					audioSource.buffer = buffer;
					if( loadCallback ) {
						loadCallback( path, true, ev );
					}
				}, 
				function(ev) {
					if( loadCallback ) {
						loadCallback( path, false, ev );
					}
				}
			);
		};
		request.onerror = function(ev) {
			if( loadCallback ) {
				loadCallback( path, false, ev );
			}
		};
		request.send();

		return audioSource;
	},

	loadSfxAtlasWebAudio: function( path, atlasEntry, loadCallback ) {
		if( this.clips[path] ) {
			return this.clips[path];
		}

		var atlasDefinition = getSfxAtlasDefinition( atlasEntry.atlas );
		var atlasPath = atlasDefinition && atlasDefinition.formats && this.format
			? atlasDefinition.formats[this.format.ext]
			: null;

		if( !atlasPath ) {
			return this.loadWebAudio( path, true, loadCallback );
		}

		var audioSource = new ig.Sound.AtlasWebAudioSource(
			null,
			atlasEntry.start || 0,
			atlasEntry.duration || 0
		);
		this.clips[path] = audioSource;

		this.loadSfxAtlasBuffer( atlasEntry.atlas, function( status, buffer, ev ) {
			if( status ) {
				audioSource.buffer = buffer;
			}

			if( loadCallback ) {
				loadCallback( path, status, ev );
			}
		});

		return audioSource;
	},

	loadSfxAtlasBuffer: function( atlasIndex, callback ) {
		var atlasDefinition = getSfxAtlasDefinition( atlasIndex );
		var extension = this.format && this.format.ext;
		var atlasUrl = atlasDefinition && atlasDefinition.formats && extension
			? atlasDefinition.formats[extension]
			: null;

		if( !atlasUrl ) {
			callback( false, null, null );
			return;
		}

		var cacheKey = atlasIndex + ':' + extension;
		var cacheRecord = this.sfxAtlasCache[cacheKey];
		if( !cacheRecord ) {
			cacheRecord = this.sfxAtlasCache[cacheKey] = {
				loading: false,
				loaded: false,
				failed: false,
				buffer: null,
				callbacks: []
			};
		}

		if( cacheRecord.loaded ) {
			callback( true, cacheRecord.buffer, null );
			return;
		}

		if( cacheRecord.failed ) {
			callback( false, null, null );
			return;
		}

		cacheRecord.callbacks.push( callback );
		if( cacheRecord.loading ) {
			return;
		}

		cacheRecord.loading = true;

		var request = new XMLHttpRequest();
		request.open( 'GET', appendCacheSuffix( atlasUrl ), true );
		request.responseType = 'arraybuffer';

		var that = this;
		var notifyCallbacks = function( status, buffer, ev ) {
			var callbacks = cacheRecord.callbacks.slice(0);
			cacheRecord.callbacks.length = 0;

			for( var i = 0; i < callbacks.length; i++ ) {
				callbacks[i]( status, buffer, ev );
			}
		};
		var fail = function( ev ) {
			cacheRecord.loading = false;
			cacheRecord.failed = true;
			notifyCallbacks( false, null, ev );
		};

		request.onload = function( ev ) {
			try {
				that.audioContext.decodeAudioData(
					request.response,
					function( buffer ) {
						cacheRecord.loading = false;
						cacheRecord.loaded = true;
						cacheRecord.buffer = buffer;
						notifyCallbacks( true, buffer, ev );
					},
					fail
				);
			}
			catch( err ) {
				fail( err );
			}
		};
		request.onerror = fail;
		request.send();
	},

	loadMusicAtlasHTML5: function( path, atlasEntry, loadCallback ) {
		if( this.clips[path] ) {
			return this.clips[path];
		}

		var atlasDefinition = getMusicAtlasDefinition( atlasEntry.atlas );
		var atlasPath = atlasDefinition && atlasDefinition.formats && this.format
			? atlasDefinition.formats[this.format.ext]
			: null;

		if( !atlasPath ) {
			return this.loadHTML5Audio( path, false, loadCallback );
		}

		var audioSource = new ig.Sound.MusicAtlasHTML5Source(
			appendCacheSuffix( atlasPath ),
			atlasEntry.start || 0,
			atlasEntry.duration || 0
		);

		if( loadCallback ) {
			if( ig.ua.mobile ) {
				setTimeout(function(){
					loadCallback( path, true, null );
				}, 0);
			}
			else {
				audioSource.addEventListener( 'canplaythrough', function cb(ev){
					audioSource.removeEventListener('canplaythrough', cb, false);
					loadCallback( path, true, ev );
				}, false );

				audioSource.addEventListener( 'error', function(ev){
					loadCallback( path, false, ev );
				}, false);
			}
		}

		audioSource.preload = 'auto';
		audioSource.load();

		this.clips[path] = audioSource;
		return audioSource;
	},
	
	loadHTML5Audio: function( path, multiChannel, loadCallback ) {
		
		// Path to the soundfile with the right extension (.ogg or .mp3)
		var realPath = ig.prefix + path.replace(/[^\.]+$/, this.format.ext) + ig.nocache;
		
		// Sound file already loaded?
		if( this.clips[path] ) {
			// Loaded as WebAudio, but now requested as HTML5 Audio? Probably Music?
			if( this.clips[path] instanceof ig.Sound.WebAudioSource ) {
				return this.clips[path];
			}

			if( this.clips[path] instanceof ig.Sound.MusicAtlasHTML5Source ) {
				return this.clips[path];
			}
			
			// Only loaded as single channel and now requested as multichannel?
			if( multiChannel && this.clips[path].length < ig.Sound.channels ) {
				for( var i = this.clips[path].length; i < ig.Sound.channels; i++ ) {
					var a = new Audio( realPath );
					a.load();
					this.clips[path].push( a );
				}
			}
			return this.clips[path][0];
		}
		
		var clip = new Audio( realPath );
		if( loadCallback ) {
			
			// The canplaythrough event is dispatched when the browser determines
			// that the sound can be played without interuption, provided the
			// download rate doesn't change.
			// Mobile browsers stubbornly refuse to preload HTML5, so we simply
			// ignore the canplaythrough event and immediately "fake" a successful
			// load callback
			if( ig.ua.mobile ) {
				setTimeout(function(){
					loadCallback( path, true, null );
				}, 0);
			}
			else {
				clip.addEventListener( 'canplaythrough', function cb(ev){
					clip.removeEventListener('canplaythrough', cb, false);
					loadCallback( path, true, ev );
				}, false );

				clip.addEventListener( 'error', function(ev){
					loadCallback( path, false, ev );
				}, false);
			}
		}
		clip.preload = 'auto';
		clip.load();
		
		
		this.clips[path] = [clip];
		if( multiChannel ) {
			for( var i = 1; i < ig.Sound.channels; i++ ) {
				var a = new Audio(realPath);
				a.load();
				this.clips[path].push( a );
			}
		}
		
		return clip;
	},
	
	
	get: function( path ) {
		// Find and return a channel that is not currently playing	
		var channels = this.clips[path];

		// Is this a WebAudio source? We only ever have one for each Sound
		if( channels && channels instanceof ig.Sound.WebAudioSource ) {
			return channels;
		}

		if( channels && channels instanceof ig.Sound.MusicAtlasHTML5Source ) {
			return channels;
		}

		// Oldschool HTML5 Audio - find a channel that's not currently 
		// playing or, if all are playing, rewind one
		for( var i = 0, clip; clip = channels[i++]; ) {
			if( clip.paused || clip.ended ) {
				if( clip.ended ) {
					clip.currentTime = 0;
				}
				return clip;
			}
		}
		
		// Still here? Pause and rewind the first channel
		channels[0].pause();
		channels[0].currentTime = 0;
		return channels[0];
	}
});

ig.Music = ig.Class.extend({
	tracks: [],
	namedTracks: {},
	currentTrack: null,
	currentIndex: 0,
	random: false,
	
	_volume: 1,
	_loop: false,
	_fadeInterval: 0,
	_fadeTimer: null,
	_endedCallbackBound: null,
	
	
	init: function() {
		this._endedCallbackBound = this._endedCallback.bind(this);
		
		Object.defineProperty(this,"volume", { 
			get: this.getVolume.bind(this),
			set: this.setVolume.bind(this)
		});
		
		Object.defineProperty(this,"loop", { 
			get: this.getLooping.bind(this),
			set: this.setLooping.bind(this)
		});
	},
	
	
	add: function( music, name ) {
		if( !ig.Sound.enabled ) {
			return;
		}
		
		var path = music instanceof ig.Sound ? music.path : music;
		
		var track = ig.soundManager.load(path, false);

		// Did we get a WebAudio Source? This is suboptimal; Music should be loaded
		// as HTML5 Audio so it can be streamed
		if( track instanceof ig.Sound.WebAudioSource ) {
			// Since this error will likely occur at game start, we stop the game
			// to not produce any more errors.
			ig.system.stopRunLoop();
			throw(
				"Sound '"+path+"' loaded as Multichannel but used for Music. " +
				"Set the multiChannel param to false when loading, e.g.: new ig.Sound(path, false)"
			);
		}

		track.loop = this._loop;
		track.volume = this._volume;
		track.addEventListener( 'ended', this._endedCallbackBound, false );
		this.tracks.push( track );
		
		if( name ) {
			this.namedTracks[name] = track;
		}
		
		if( !this.currentTrack ) {
			this.currentTrack = track;
		}
	},
	
	
	next: function() {
		if( !this.tracks.length ) { return; }
		
		this.stop();
		this.currentIndex = this.random
			? Math.floor(Math.random() * this.tracks.length)
			: (this.currentIndex + 1) % this.tracks.length;
		this.currentTrack = this.tracks[this.currentIndex];
		this.play();
	},
	
	
	pause: function() {
		if( !this.currentTrack ) { return; }
		this.currentTrack.pause();
	},
	
	
	stop: function() {
		if( !this.currentTrack ) { return; }
		this.currentTrack.pause();
		this.currentTrack.currentTime = 0;
	},
	
	
	play: function( name ) {
		// If a name was provided, stop playing the current track (if any)
		// and play the named track
		if( name && this.namedTracks[name] ) {
			var newTrack = this.namedTracks[name];
			if( newTrack != this.currentTrack ) {
				this.stop();
				this.currentTrack = newTrack;
			}
		}
		else if( !this.currentTrack ) { 
			return; 
		}
		this.currentTrack.play();
	},
	
		
	getLooping: function() {
		return this._loop;
	},
	
	
	setLooping: function( l ) {
		this._loop = l;
		for( var i in this.tracks ) {
			this.tracks[i].loop = l;
		}
	},	
		
	
	getVolume: function() {
		return this._volume;
	},
	
	
	setVolume: function( v ) {
		this._volume = v.limit(0,1);
		for( var i in this.tracks ) {
			this.tracks[i].volume = this._volume;
		}
	},
	
	
	fadeOut: function( time ) {
		if( !this.currentTrack ) { return; }
		
		clearInterval( this._fadeInterval );
		this._fadeTimer = new ig.Timer( time );
		this._fadeInterval = setInterval( this._fadeStep.bind(this), 50 );
	},
	
	
	_fadeStep: function() {
		var v = this._fadeTimer.delta()
			.map(-this._fadeTimer.target, 0, 1, 0)
			.limit( 0, 1 )
			* this._volume;
		
		if( v <= 0.01 ) {
			this.stop();
			this.currentTrack.volume = this._volume;
			clearInterval( this._fadeInterval );
		}
		else {
			this.currentTrack.volume = v;
		}
	},
	
	_endedCallback: function() {
		if( this._loop ) {
			this.play();
		}
		else {
			this.next();
		}
	}
});



ig.Sound = ig.Class.extend({
	path: '',
	volume: 1,
	currentClip: null,
	multiChannel: true,
	_loop: false,
	
	
	init: function( path, multiChannel ) {
		this.path = path;
		this.multiChannel = (multiChannel !== false);

		Object.defineProperty(this,"loop", { 
			get: this.getLooping.bind(this),
			set: this.setLooping.bind(this)
		});
		
		this.load();
	},

	getLooping: function() {
		return this._loop;
	},

	setLooping: function( loop ) {
		this._loop = loop;

		if( this.currentClip ) {
			this.currentClip.loop = loop;
		}
	},	
	
	load: function( loadCallback ) {
		if( !ig.Sound.enabled ) {
			if( loadCallback ) {
				loadCallback( this.path, true );
			}
			return;
		}
		
		if( ig.ready ) {
			ig.soundManager.load( this.path, this.multiChannel, loadCallback );
		}
		else {
			ig.addResource( this );
		}
	},
	
	
	play: function() {
		if( !ig.Sound.enabled ) {
			return;
		}
		
		this.currentClip = ig.soundManager.get( this.path );
		this.currentClip.loop = this._loop;
		this.currentClip.volume = ig.soundManager.volume * this.volume;
		this.currentClip.play();
	},
	
	
	stop: function() {
		if( this.currentClip ) {
			this.currentClip.pause();
			this.currentClip.currentTime = 0;
		}
	}
});

// Music-atlas uses one streaming HTML5 Audio element and seeks inside the atlas.
// This reduces baked request count, but segment boundaries are not sample accurate;
// exact seamless loops should keep individual files or use a future optional
// WebAudio music mode.
ig.Sound.MusicAtlasHTML5Source = ig.Class.extend({
	audio: null,
	offset: 0,
	duration: 0,
	end: 0,
	_loop: false,
	_volume: 1,
	_ended: false,
	_listeners: null,
	_boundaryTimer: null,
	_pendingSeek: null,
	_pendingPlay: false,

	init: function( atlasUrl, offset, duration ) {
		this.audio = new Audio( atlasUrl );
		this.offset = offset || 0;
		this.duration = duration || 0;
		this.end = this.offset + this.duration;
		this._listeners = {};
		this.audio.loop = false;

		Object.defineProperty(this, 'currentTime', {
			get: this.getCurrentTime.bind(this),
			set: this.setCurrentTime.bind(this)
		});

		Object.defineProperty(this, 'loop', {
			get: this.getLooping.bind(this),
			set: this.setLooping.bind(this)
		});

		Object.defineProperty(this, 'volume', {
			get: this.getVolume.bind(this),
			set: this.setVolume.bind(this)
		});

		Object.defineProperty(this, 'paused', {
			get: function(){ return this.audio.paused; }.bind(this)
		});

		Object.defineProperty(this, 'ended', {
			get: function(){ return this._ended; }.bind(this)
		});

		Object.defineProperty(this, 'preload', {
			get: function(){ return this.audio.preload; }.bind(this),
			set: function(value){ this.audio.preload = value; }.bind(this)
		});

		this.audio.addEventListener('loadedmetadata', this._handleLoadedMetadata.bind(this), false);
		this.audio.addEventListener('timeupdate', this._checkBoundary.bind(this), false);
		this.audio.addEventListener('ended', this._handleUnderlyingEnded.bind(this), false);
	},

	load: function() {
		this.audio.load();
	},

	play: function() {
		this._ended = false;

		if( !this._isInsideSegment() || this.audio.currentTime >= this.end - 0.025 ) {
			this._seekToAtlasTime( this.offset );
		}

		if( this.audio.readyState < 1 ) {
			this._pendingPlay = true;
			this.audio.load();
			return;
		}

		var result = this.audio.play();
		this._scheduleBoundaryCheck();
		return result;
	},

	pause: function() {
		this.audio.pause();
		this._clearBoundaryCheck();
	},

	getCurrentTime: function() {
		return this._clampRelativeTime( this.audio.currentTime - this.offset );
	},

	setCurrentTime: function( value ) {
		this._ended = false;
		this._seekToRelativeTime( value );
	},

	getLooping: function() {
		return this._loop;
	},

	setLooping: function( value ) {
		this._loop = !!value;
		this.audio.loop = false;
	},

	getVolume: function() {
		return this.audio.volume;
	},

	setVolume: function( value ) {
		if( value && value.limit ) {
			this.audio.volume = value.limit(0, 1);
			return;
		}

		var volume = Number(value);
		this.audio.volume = isNaN(volume) ? 0 : Math.max(0, Math.min(1, volume));
	},

	addEventListener: function( type, listener, options ) {
		if( type === 'ended' ) {
			this._listeners[type] = this._listeners[type] || [];
			this._listeners[type].push( listener );
			return;
		}

		this.audio.addEventListener( type, listener, options || false );
	},

	removeEventListener: function( type, listener, options ) {
		if( type === 'ended' && this._listeners[type] ) {
			if( this._listeners[type].erase ) {
				this._listeners[type].erase(listener);
			}
			else {
				this._listeners[type] = this._listeners[type].filter(function(fn){
					return fn !== listener;
				});
			}
			return;
		}

		this.audio.removeEventListener( type, listener, options || false );
	},

	_clampRelativeTime: function( value ) {
		value = Number(value) || 0;
		return Math.max(0, Math.min(this.duration, value));
	},

	_isInsideSegment: function() {
		return this.audio.currentTime >= this.offset && this.audio.currentTime < this.end;
	},

	_seekToRelativeTime: function( value ) {
		this._seekToAtlasTime( this.offset + this._clampRelativeTime(value) );
	},

	_seekToAtlasTime: function( value ) {
		this._pendingSeek = value;

		try {
			this.audio.currentTime = value;
			this._pendingSeek = null;
		}
		catch( err ) {
			// Some browsers require metadata before seeking.
		}
	},

	_handleLoadedMetadata: function() {
		if( this._pendingSeek !== null ) {
			var pendingSeek = this._pendingSeek;
			this._pendingSeek = null;
			this._seekToAtlasTime( pendingSeek );
		}

		if( this._pendingPlay ) {
			this._pendingPlay = false;
			this.play();
		}
	},

	_scheduleBoundaryCheck: function() {
		this._clearBoundaryCheck();

		if( this.audio.paused ) {
			return;
		}

		var remaining = Math.max(0, this.end - this.audio.currentTime);
		var delay = Math.max(0, (remaining * 1000) - 25);

		this._boundaryTimer = setTimeout(this._checkBoundary.bind(this), delay);
	},

	_clearBoundaryCheck: function() {
		if( this._boundaryTimer !== null ) {
			clearTimeout( this._boundaryTimer );
			this._boundaryTimer = null;
		}
	},

	_checkBoundary: function() {
		if( this.audio.paused ) {
			return;
		}

		if( this.audio.currentTime < this.end - 0.025 ) {
			this._scheduleBoundaryCheck();
			return;
		}

		if( this._loop ) {
			this._seekToAtlasTime( this.offset );
			this.audio.play();
			this._scheduleBoundaryCheck();
			return;
		}

		this.audio.pause();
		this._seekToAtlasTime( this.offset );
		this._ended = true;
		this._clearBoundaryCheck();
		this._dispatchEvent( 'ended' );
	},

	_handleUnderlyingEnded: function() {
		if( this._loop ) {
			this._seekToAtlasTime( this.offset );
			this.audio.play();
			this._scheduleBoundaryCheck();
			return;
		}

		this._seekToAtlasTime( this.offset );
		this._ended = true;
		this._clearBoundaryCheck();
		this._dispatchEvent( 'ended' );
	},

	_dispatchEvent: function( type ) {
		var listeners = (this._listeners[type] || []).slice(0);
		var event = { type: type, target: this, currentTarget: this };

		for( var i = 0; i < listeners.length; i++ ) {
			listeners[i].call( this, event );
		}
	}
});


ig.Sound.WebAudioSource = ig.Class.extend({
	sources: [],
	gain: null,
	buffer: null,
	_loop: false,

	init: function() {
		this.sources = [];
		this.gain = ig.soundManager.audioContext.createGain();
		this.gain.connect(ig.soundManager.audioContext.destination);

		Object.defineProperty(this,"loop", { 
			get: this.getLooping.bind(this),
			set: this.setLooping.bind(this)
		});

		Object.defineProperty(this,"volume", { 
			get: this.getVolume.bind(this),
			set: this.setVolume.bind(this)
		});
	},

	play: function() {
		if( !this.buffer ) { return; }
		var source = ig.soundManager.audioContext.createBufferSource();
		source.buffer = this.buffer;
		source.connect(this.gain); 
		source.loop = this._loop;

		// Add this new source to our sources array and remove it again
		// later when it has finished playing.
		var that = this;
		this.sources.push(source);
		source.onended = function(){ that.sources.erase(source); };

		source.start(0);
	},

	pause: function() {
		for( var i = 0; i < this.sources.length; i++ ) {
			try{
				this.sources[i].stop();
			} catch(err){}
		}
	},

	getLooping: function() {
		return this._loop;
	},

	setLooping: function( loop ) {
		this._loop = loop;

		for( var i = 0; i < this.sources.length; i++ ) {
			this.sources[i].loop = loop;
		}
	},

	getVolume: function() {
		return this.gain.gain.value;
	},

	setVolume: function( volume ) {
		this.gain.gain.value = volume;
	}
});

ig.Sound.AtlasWebAudioSource = ig.Sound.WebAudioSource.extend({
	offset: 0,
	duration: 0,

	init: function( buffer, offset, duration ) {
		this.parent();
		this.sources = [];
		this.buffer = buffer || null;
		this.offset = offset || 0;
		this.duration = duration || 0;
	},

	play: function() {
		if( !this.buffer ) { return; }
		var source = ig.soundManager.audioContext.createBufferSource();
		source.buffer = this.buffer;
		source.connect(this.gain);
		source.loop = this._loop;

		if( this._loop ) {
			source.loopStart = this.offset;
			source.loopEnd = this.offset + this.duration;
		}

		// Add this new source to our sources array and remove it again
		// later when it has finished playing.
		var that = this;
		this.sources.push(source);
		source.onended = function(){ that.sources.erase(source); };

		if( this._loop ) {
			source.start(0, this.offset);
		}
		else {
			source.start(0, this.offset, this.duration);
		}
	}
});


ig.Sound.FORMAT = {
	MP3: {ext: 'mp3', mime: 'audio/mpeg'},
	M4A: {ext: 'm4a', mime: 'audio/mp4; codecs=mp4a.40.2'},
	OGG: {ext: 'ogg', mime: 'audio/ogg; codecs=vorbis'},
	WEBM: {ext: 'webm', mime: 'audio/webm; codecs=vorbis'},
	CAF: {ext: 'caf', mime: 'audio/x-caf'}
};
ig.Sound.use = [ig.Sound.FORMAT.OGG, ig.Sound.FORMAT.MP3];
ig.Sound.channels = 4;
ig.Sound.enabled = true;

ig.Sound.useWebAudio = !!window.AudioContext;
