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

const getTextureAtlasManifest = function() {
	return globalScope.__THESEUS_TEXTURE_ATLAS_MANIFEST__ || null;
};

const getTextureAtlasEntry = function( path ) {
	// Atlas entries are keyed by the original ig.Image path, e.g. media/player.png.
	var manifest = getTextureAtlasManifest();
	if( !manifest || !manifest.images ) {
		return null;
	}

	return manifest.images[ normalizePath(path) ] || null;
};

const getTextureAtlasPageDefinition = function( atlasIndex ) {
	var manifest = getTextureAtlasManifest();
	if( !manifest || !manifest.atlases || !manifest.atlases[atlasIndex] ) {
		return null;
	}

	return manifest.atlases[atlasIndex];
};

const createScaledImage = function( image, width, height, scale ) {
	var origPixels = ig.getImagePixels( image, 0, 0, width, height );
	var widthScaled = width * scale;
	var heightScaled = height * scale;
	var scaled = ig.$new('canvas');
	var scaledCtx = scaled.getContext('2d');
	var scaledPixels = null;

		scaled.width = widthScaled;
		scaled.height = heightScaled;
		scaledPixels = scaledCtx.getImageData( 0, 0, widthScaled, heightScaled );

	for( var y = 0; y < heightScaled; y++ ) {
		for( var x = 0; x < widthScaled; x++ ) {
			var index = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
			var indexScaled = (y * widthScaled + x) * 4;
			scaledPixels.data[ indexScaled ] = origPixels.data[ index ];
			scaledPixels.data[ indexScaled+1 ] = origPixels.data[ index+1 ];
			scaledPixels.data[ indexScaled+2 ] = origPixels.data[ index+2 ];
			scaledPixels.data[ indexScaled+3 ] = origPixels.data[ index+3 ];
		}
	}
	scaledCtx.putImageData( scaledPixels, 0, 0 );
	return scaled;
};

const getAtlasPageCache = function( atlasIndex ) {
	var atlasCache = ig.Image.atlasCache;
	var atlasPage = atlasCache[atlasIndex];

	if( atlasPage ) {
		return atlasPage;
	}

	var atlasDefinition = getTextureAtlasPageDefinition( atlasIndex );
	if( !atlasDefinition ) {
		return null;
	}

	atlasPage = atlasCache[atlasIndex] = {
		url: atlasDefinition.image,
		data: null,
		width: atlasDefinition.width || 0,
		height: atlasDefinition.height || 0,
		loaded: false,
		failed: false,
		callbacks: [],
		scaledData: {}
	};

	return atlasPage;
};

const notifyAtlasPageCallbacks = function( atlasPage, status ) {
	var callbacks = atlasPage.callbacks.slice(0);
	atlasPage.callbacks.length = 0;

	for( var i = 0; i < callbacks.length; i++ ) {
		callbacks[i]( status, atlasPage );
	}
};

const loadAtlasPage = function( atlasIndex, callback ) {
	var atlasPage = getAtlasPageCache( atlasIndex );
	var image = null;

	if( !atlasPage ) {
		callback( false, null );
		return;
	}

	if( atlasPage.loaded ) {
		callback( true, atlasPage );
		return;
	}

	if( atlasPage.failed ) {
		callback( false, atlasPage );
		return;
	}

	atlasPage.callbacks.push( callback );
	if( atlasPage.loading ) {
		return;
	}

	atlasPage.loading = true;
	image = new Image();
	image.onload = function() {
		atlasPage.loading = false;
		atlasPage.loaded = true;
		atlasPage.data = image;
		atlasPage.width = image.width;
		atlasPage.height = image.height;
		notifyAtlasPageCallbacks( atlasPage, true );
	};
	image.onerror = function() {
		atlasPage.loading = false;
		atlasPage.failed = true;
		notifyAtlasPageCallbacks( atlasPage, false );
	};
	image.src = appendCacheSuffix( atlasPage.url );
};

const getAtlasPageDataForScale = function( atlasPage, scale ) {
	if( scale === 1 ) {
		return atlasPage.data;
	}

	if( !atlasPage.scaledData[scale] ) {
		atlasPage.scaledData[scale] = createScaledImage( atlasPage.data, atlasPage.width, atlasPage.height, scale );
	}

	return atlasPage.scaledData[scale];
};

ig.Image = ig.Class.extend({
	data: null,
	width: 0,
	height: 0,
	loaded: false,
	failed: false,
	loadCallback: null,
	path: '',
	atlasEntry: null,
	_dataScale: 1,
	
	
	staticInstantiate: function( path ) {
		return ig.Image.cache[path] || null;
	},
	
	
	init: function( path ) {
		this.path = path;
		this.load();
	},
	
	
	load: function( loadCallback ) {
		if( this.loaded ) {
			if( loadCallback ) {
				loadCallback( this.path, true );
			}
			return;
		}
		else if( !this.loaded && ig.ready ) {
			this.loadCallback = loadCallback || null;
			this.failed = false;
			this.atlasEntry = getTextureAtlasEntry( this.path );
			this._dataScale = 1;
			
			if( this.atlasEntry ) {
				this.loadFromTextureAtlas();
			}
			else {
				this.loadUnpacked();
			}
		}
		else {
			ig.addResource( this );
		}

		ig.Image.cache[this.path] = this;
	},


	loadUnpacked: function() {
		this.data = new Image();
		this.data.onload = this.onload.bind(this);
		this.data.onerror = this.onerror.bind(this);
		this.data.src = appendCacheSuffix( ig.prefix + this.path );
	},

	
	loadFromTextureAtlas: function() {
		var atlasIndex = this.atlasEntry && typeof this.atlasEntry.atlas === 'number' ? this.atlasEntry.atlas : -1;
		loadAtlasPage( atlasIndex, this.onloadFromTextureAtlas.bind(this) );
	},


	reload: function() {
		this.loaded = false;
		this.failed = false;
		this.data = null;
		this.load();
	},


	onloadFromTextureAtlas: function( status, atlasPage ) {
		if( !status || !atlasPage ) {
			this.atlasEntry = null;
			this.loadUnpacked();
			return;
		}

		this.data = atlasPage.data;
		this.onload({ atlasPage: atlasPage, packed: true });
	},

	
	onload: function( event ) {
		var atlasPage = null;

		if( this.atlasEntry ) {
			atlasPage = event && event.atlasPage ? event.atlasPage : getAtlasPageCache( this.atlasEntry.atlas );
			this.width = this.atlasEntry.sourceSize ? this.atlasEntry.sourceSize.w : this.atlasEntry.frame.w;
			this.height = this.atlasEntry.sourceSize ? this.atlasEntry.sourceSize.h : this.atlasEntry.frame.h;
			this.loaded = true;
			this._dataScale = 1;
			this.data = atlasPage ? atlasPage.data : this.data;

			if( ig.system.scale != 1 ) {
				this.resize( ig.system.scale );
			}
		}
			else {
				this.width = this.data.width;
				this.height = this.data.height;
				this.loaded = true;
				this._dataScale = 1;

				if( ig.system.scale != 1 ) {
					this.resize( ig.system.scale );
				}
			}
		
		if( this.loadCallback ) {
			this.loadCallback( this.path, true );
		}
	},


	onerror: function( event ) {
		this.failed = true;
		
		if( this.loadCallback ) {
			this.loadCallback( this.path, false );
		}
	},


	getSourceRect: function( sourceX, sourceY, width, height ) {
		var scale = ig.system.scale;
		var atlasOffsetX = this.atlasEntry ? this.atlasEntry.frame.x * scale : 0;
		var atlasOffsetY = this.atlasEntry ? this.atlasEntry.frame.y * scale : 0;

			return {
				x: atlasOffsetX + sourceX * scale,
				y: atlasOffsetY + sourceY * scale,
				width: width * scale,
				height: height * scale
			};
		},


		getImagePixels: function( x, y, width, height ) {
		var scale = this._dataScale || 1;
		var atlasOffsetX = this.atlasEntry ? this.atlasEntry.frame.x * scale : 0;
		var atlasOffsetY = this.atlasEntry ? this.atlasEntry.frame.y * scale : 0;

		return ig.getImagePixels(
			this.data,
			atlasOffsetX + x * scale,
			atlasOffsetY + y * scale,
			width * scale,
			height * scale
		);
	},
	
	
	resize: function( scale ) {
		if( this.atlasEntry ) {
			var atlasPage = getAtlasPageCache( this.atlasEntry.atlas );
			if( atlasPage && atlasPage.loaded ) {
				this.data = getAtlasPageDataForScale( atlasPage, scale );
				this._dataScale = scale;
			}
			return;
		}

		this.data = createScaledImage( this.data, this.width, this.height, scale );
		this._dataScale = scale;
	},
	
	
	draw: function( targetX, targetY, sourceX, sourceY, width, height ) {
		var sourceRect = null;

		if( !this.loaded ) { return; }
		
		sourceX = sourceX || 0;
		sourceY = sourceY || 0;
		width = width || this.width;
		height = height || this.height;
		sourceRect = this.getSourceRect( sourceX, sourceY, width, height );
		
		ig.system.context.drawImage( 
			this.data, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height,
			ig.system.getDrawPos(targetX), 
			ig.system.getDrawPos(targetY),
			sourceRect.width, sourceRect.height
		);
		
		ig.Image.drawCount++;
	},
	
	
	drawTile: function( targetX, targetY, tile, tileWidth, tileHeight, flipX, flipY ) {
		tileHeight = tileHeight ? tileHeight : tileWidth;
		
		if( !this.loaded || tileWidth > this.width || tileHeight > this.height ) { return; }
		
		var scale = ig.system.scale;
		var tileWidthScaled = Math.floor(tileWidth * scale);
		var tileHeightScaled = Math.floor(tileHeight * scale);
		var sourceX = Math.floor(tile * tileWidth) % this.width;
		var sourceY = Math.floor(tile * tileWidth / this.width) * tileHeight;
		var sourceRect = this.getSourceRect( sourceX, sourceY, tileWidth, tileHeight );
		
		var scaleX = flipX ? -1 : 1;
		var scaleY = flipY ? -1 : 1;
		
		if( flipX || flipY ) {
			ig.system.context.save();
			ig.system.context.scale( scaleX, scaleY );
		}
		ig.system.context.drawImage( 
			this.data,
			sourceRect.x,
			sourceRect.y,
			tileWidthScaled,
			tileHeightScaled,
			ig.system.getDrawPos(targetX) * scaleX - (flipX ? tileWidthScaled : 0), 
			ig.system.getDrawPos(targetY) * scaleY - (flipY ? tileHeightScaled : 0),
			tileWidthScaled,
			tileHeightScaled
		);
		if( flipX || flipY ) {
			ig.system.context.restore();
		}
		
		ig.Image.drawCount++;
	}
});

ig.Image.drawCount = 0;
ig.Image.cache = {};
ig.Image.atlasCache = {};
ig.Image.reloadCache = function() {
	ig.Image.atlasCache = {};
	for( var path in ig.Image.cache ) {
		ig.Image.cache[path].reload();
	}
};
