import ig from './ig.js';
import './image.js';

ig.Font = ig.Image.extend({
	widthMap: [],
	heightMap: [],
	indices: [],
	topMap: [],
	bottomMap: [],
	firstChar: 32,
	alpha: 1,
	letterSpacing: 1,
	lineSpacing: 0,
	_visualTop: 0,
	_visualBottom: 0,
	_visualHeight: 0,
	
	
	onload: function( ev ) {
		var sourceWidth = this.atlasEntry && this.atlasEntry.sourceSize
			? this.atlasEntry.sourceSize.w
			: this.data.width;
		var sourceHeight = this.atlasEntry && this.atlasEntry.sourceSize
			? this.atlasEntry.sourceSize.h
			: this.data.height;

		this._loadMetrics( sourceWidth, sourceHeight );
		this._loadVisualMetrics( sourceWidth, sourceHeight );
		this._loadGlyphVisualMetrics( sourceWidth, sourceHeight );
		this.parent( ev );
		this.height -= 2; // last 2 lines contain no visual data
	},


	widthForString: function( text, options ) {
		if( typeof(text) != 'string' ) {
			text = text.toString();
		}

		var drawOptions = this._normalizeDrawOptions( options );
		var lines = this._linesForText( text, drawOptions );
		var width = 0;
		for( var i = 0; i < lines.length; i++ ) {
			width = Math.max( width, this._widthForLine(lines[i], drawOptions) );
		}
		return width;
	},

	
	_widthForLine: function( text, options ) {
		var letterSpacing = options && typeof(options.letterSpacing) == 'number' && isFinite(options.letterSpacing)
			? options.letterSpacing
			: this.letterSpacing;
		var width = 0;
		for( var i = 0; i < text.length; i++ ) {
			width += this.widthMap[text.charCodeAt(i) - this.firstChar];
		}
		if( text.length > 0 ) {
			width += letterSpacing * (text.length - 1);
		}
		return width;
	},


	heightForString: function( text, options ) {
		if( typeof(text) != 'string' ) {
			text = text.toString();
		}

		var drawOptions = this._normalizeDrawOptions( options );
		return this._heightForLines( this._linesForText(text, drawOptions), drawOptions );
	},
	
	
	draw: function( text, x, y, align ) {
		if( typeof(text) != 'string' ) {
			text = text.toString();
		}

		var drawOptions = this._normalizeDrawOptions( align );
		var lines = this._linesForText( text, drawOptions );
		var lineAdvance = this.height + drawOptions.lineSpacing;

		if( drawOptions.alpha !== 1 ) {
			ig.system.context.globalAlpha = drawOptions.alpha;
		}

		var drawCount = 0;
		for( var i = 0; i < lines.length; i++ ) {
			drawCount += this._drawLine( lines[i], x, y + i * lineAdvance, drawOptions );
		}

		if( drawOptions.alpha !== 1 ) {
			ig.system.context.globalAlpha = 1;
		}
		ig.Image.drawCount += drawCount;
	},


	_normalizeDrawOptions: function( options ) {
		var drawOptions = {
			align: ig.Font.ALIGN.LEFT,
			verticalAlign: ig.Font.VALIGN.FONT,
			maxWidth: null,
			alpha: this.alpha,
			letterSpacing: this.letterSpacing,
			lineSpacing: this.lineSpacing
		};

		if( typeof(options) == 'number' ) {
			drawOptions.align = options;
		}
		else if( options && typeof(options) == 'object' ) {
			if( options.align !== undefined ) {
				drawOptions.align = options.align;
			}
			if( options.verticalAlign !== undefined ) {
				drawOptions.verticalAlign = this._normalizeVerticalAlign( options.verticalAlign );
			}
			if( typeof(options.maxWidth) == 'number' && isFinite(options.maxWidth) && options.maxWidth > 0 ) {
				drawOptions.maxWidth = options.maxWidth;
			}
			if( typeof(options.alpha) == 'number' && isFinite(options.alpha) ) {
				drawOptions.alpha = options.alpha;
			}
			if( typeof(options.letterSpacing) == 'number' && isFinite(options.letterSpacing) ) {
				drawOptions.letterSpacing = options.letterSpacing;
			}
			if( typeof(options.lineSpacing) == 'number' && isFinite(options.lineSpacing) ) {
				drawOptions.lineSpacing = options.lineSpacing;
			}
		}

		return drawOptions;
	},


	_normalizeVerticalAlign: function( verticalAlign ) {
		if( verticalAlign == ig.Font.VALIGN.FONT || verticalAlign === 'font' || verticalAlign === 'FONT' ) {
			return ig.Font.VALIGN.FONT;
		}
		if( verticalAlign == ig.Font.VALIGN.TOP || verticalAlign === 'top' || verticalAlign === 'TOP' ) {
			return ig.Font.VALIGN.TOP;
		}
		if( verticalAlign == ig.Font.VALIGN.MIDDLE || verticalAlign === 'middle' || verticalAlign === 'MIDDLE' ) {
			return ig.Font.VALIGN.MIDDLE;
		}
		if( verticalAlign == ig.Font.VALIGN.BOTTOM || verticalAlign === 'bottom' || verticalAlign === 'BOTTOM' ) {
			return ig.Font.VALIGN.BOTTOM;
		}
		return ig.Font.VALIGN.FONT;
	},


	_linesForText: function( text, options ) {
		var sourceLines = text.split( '\n' );
		if( !(options && options.maxWidth) ) {
			return sourceLines;
		}

		var lines = [];
		for( var i = 0; i < sourceLines.length; i++ ) {
			var wrappedLines = this._wrapLine( sourceLines[i], options.maxWidth, options );
			for( var j = 0; j < wrappedLines.length; j++ ) {
				lines.push( wrappedLines[j] );
			}
		}
		return lines;
	},


	_wrapLine: function( text, maxWidth, options ) {
		if( text === '' ) {
			return [''];
		}

		var tokens = text.match( /\s+|\S+/g );
		if( !tokens ) {
			return [''];
		}

		var lines = [];
		var currentLine = '';
		var currentLineHasWord = false;

		for( var i = 0; i < tokens.length; i++ ) {
			var token = tokens[i];
			if( /\s/.test(token.charAt(0)) ) {
				currentLine += token;
				continue;
			}

			var candidateLine = currentLine + token;
			if( currentLineHasWord && this._widthForLine(candidateLine, options) > maxWidth ) {
				lines.push( currentLine.replace(/\s+$/, '') );
				currentLine = token;
			}
			else {
				currentLine = candidateLine;
			}
			currentLineHasWord = true;
		}

		lines.push( currentLine );
		return lines;
	},


	_heightForLines: function( lines, options ) {
		var lineSpacing = options && typeof(options.lineSpacing) == 'number' && isFinite(options.lineSpacing)
			? options.lineSpacing
			: this.lineSpacing;
		return lines.length
			? lines.length * this.height + (lines.length - 1) * lineSpacing
			: 0;
	},


	_verticalOffsetForLine: function() {
		var visualTop = this._visualHeight ? this._visualTop : 0;
		var visualBottom = this._visualHeight ? this._visualBottom : this.height - 1;

		return this.height - visualBottom - 1;
	},


	_glyphVisualMetricsForChar: function( c ) {
		var height = this.height || 0;
		var fallback = {
			top: 0,
			bottom: height - 1,
			height: height
		};

		if( c < 0 || !this.topMap || !this.bottomMap || !this.heightMap ) {
			return fallback;
		}

		var top = this.topMap[c];
		var bottom = this.bottomMap[c];
		var glyphHeight = this.heightMap[c];

		if(
			typeof(top) != 'number' || !isFinite(top) ||
			typeof(bottom) != 'number' || !isFinite(bottom) ||
			typeof(glyphHeight) != 'number' || !isFinite(glyphHeight) ||
			glyphHeight < 1 || bottom < top
		) {
			return fallback;
		}

		return {
			top: top,
			bottom: bottom,
			height: glyphHeight
		};
	},


	_verticalOffsetForChar: function( c, verticalAlign ) {
		if( verticalAlign == ig.Font.VALIGN.FONT ) {
			return this._verticalOffsetForLine();
		}

		var metrics = this._glyphVisualMetricsForChar( c );
		if( verticalAlign == ig.Font.VALIGN.TOP ) {
			return -metrics.top;
		}
		if( verticalAlign == ig.Font.VALIGN.MIDDLE ) {
			return (this.height - metrics.height) / 2 - metrics.top;
		}
		if( verticalAlign == ig.Font.VALIGN.BOTTOM ) {
			return this.height - metrics.bottom - 1;
		}
		return this._verticalOffsetForLine();
	},


	_drawLine: function( text, x, y, options ) {
		if( options.align == ig.Font.ALIGN.RIGHT || options.align == ig.Font.ALIGN.CENTER ) {
			var width = this._widthForLine( text, options );
			if( options.maxWidth ) {
				x += options.align == ig.Font.ALIGN.CENTER
					? (options.maxWidth - width) / 2
					: options.maxWidth - width;
			}
			else {
				x -= options.align == ig.Font.ALIGN.CENTER ? width/2 : width;
			}
		}

		for( var i = 0; i < text.length; i++ ) {
			var c = text.charCodeAt(i);
			var charIndex = c - this.firstChar;
			x += this._drawChar(
				charIndex,
				x,
				y + this._verticalOffsetForChar( charIndex, options.verticalAlign ),
				options.letterSpacing
			);
		}

		return text.length;
	},
	
	
	_drawChar: function( c, targetX, targetY, letterSpacing ) {
		if( !this.loaded || c < 0 || c >= this.indices.length ) { return 0; }
		var spacing = typeof(letterSpacing) == 'number' && isFinite(letterSpacing)
			? letterSpacing
			: this.letterSpacing;
		
		var scale = ig.system.scale;
		var atlasOffsetX = this.atlasEntry ? this.atlasEntry.frame.x * scale : 0;
		var atlasOffsetY = this.atlasEntry ? this.atlasEntry.frame.y * scale : 0;
		
		var charX = atlasOffsetX + this.indices[c] * scale;
		var charY = atlasOffsetY;
		var charWidth = this.widthMap[c] * scale;
		var charHeight = this.height * scale;
		
		ig.system.context.drawImage( 
			this.data,
			charX, charY,
			charWidth, charHeight,
			ig.system.getDrawPos(targetX), ig.system.getDrawPos(targetY),
			charWidth, charHeight
		);
		
		return this.widthMap[c] + spacing;
	},
	
	
	_loadMetrics: function( imageWidth, imageHeight ) {
		// Draw the bottommost line of this font image into an offscreen canvas
		// and analyze it pixel by pixel.
		// A run of non-transparent pixels represents a character and its width
		
		this.widthMap = [];
		this.indices = [];
		
		var px = this.getImagePixels( 0, imageHeight-1, imageWidth, 1 );
		
		var currentWidth = 0;
		for( var x = 0; x < imageWidth; x++ ) {
			var index = x * 4 + 3; // alpha component of this pixel
			if( px.data[index] > 127 ) {
				currentWidth++;
			}
			else if( px.data[index] < 128 && currentWidth ) {
				this.widthMap.push( currentWidth );
				this.indices.push( x-currentWidth );
				currentWidth = 0;
			}
		}
		this.widthMap.push( currentWidth );
		this.indices.push( x-currentWidth );
	},


	_loadGlyphVisualMetrics: function( imageWidth, imageHeight ) {
		var visualHeight = Math.max( imageHeight - 2, 0 );
		var fallbackBottom = visualHeight - 1;
		var fallbackHeight = visualHeight;

		this.heightMap = [];
		this.topMap = [];
		this.bottomMap = [];

		if( visualHeight < 1 ) {
			for( var emptyIndex = 0; emptyIndex < this.widthMap.length; emptyIndex++ ) {
				this.topMap.push( 0 );
				this.bottomMap.push( -1 );
				this.heightMap.push( 0 );
			}
			return;
		}

		var px = this.getImagePixels( 0, 0, imageWidth, visualHeight );

		for( var glyphIndex = 0; glyphIndex < this.widthMap.length; glyphIndex++ ) {
			var glyphX = this.indices[glyphIndex] || 0;
			var glyphWidth = this.widthMap[glyphIndex] || 0;
			var glyphTop = visualHeight;
			var glyphBottom = -1;

			for( var y = 0; y < visualHeight; y++ ) {
				for( var x = 0; x < glyphWidth; x++ ) {
					var sourceX = glyphX + x;
					if( sourceX < 0 || sourceX >= imageWidth ) {
						continue;
					}

					var index = (y * imageWidth + sourceX) * 4 + 3;
					if( px.data[index] > 0 ) {
						glyphTop = Math.min( glyphTop, y );
						glyphBottom = Math.max( glyphBottom, y );
					}
				}
			}

			if( glyphBottom < glyphTop ) {
				glyphTop = 0;
				glyphBottom = fallbackBottom;
			}

			this.topMap.push( glyphTop );
			this.bottomMap.push( glyphBottom );
			this.heightMap.push( glyphBottom >= glyphTop ? glyphBottom - glyphTop + 1 : fallbackHeight );
		}
	},


	_loadVisualMetrics: function( imageWidth, imageHeight ) {
		var visualHeight = Math.max( imageHeight - 2, 0 );
		var visualTop = visualHeight;
		var visualBottom = -1;

		if( visualHeight < 1 ) {
			this._visualTop = 0;
			this._visualBottom = -1;
			this._visualHeight = 0;
			return;
		}

		if( visualHeight > 0 ) {
			var px = this.getImagePixels( 0, 0, imageWidth, visualHeight );

			for( var y = 0; y < visualHeight; y++ ) {
				for( var x = 0; x < imageWidth; x++ ) {
					var index = (y * imageWidth + x) * 4 + 3;
					if( px.data[index] > 0 ) {
						visualTop = Math.min( visualTop, y );
						visualBottom = Math.max( visualBottom, y );
					}
				}
			}
		}

		if( visualBottom < visualTop ) {
			visualTop = 0;
			visualBottom = Math.max( visualHeight - 1, 0 );
		}

		this._visualTop = visualTop;
		this._visualBottom = visualBottom;
		this._visualHeight = visualBottom - visualTop + 1;
	}
});


ig.Font.ALIGN = {
	LEFT: 0,
	RIGHT: 1,
	CENTER: 2
};

ig.Font.VALIGN = {
	TOP: 0,
	MIDDLE: 1,
	BOTTOM: 2,
	FONT: 3
};
