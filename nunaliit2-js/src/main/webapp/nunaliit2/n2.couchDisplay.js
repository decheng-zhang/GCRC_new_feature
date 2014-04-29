/*
Copyright (c) 2010, Geomatics and Cartographic Research Centre, Carleton 
University
All rights reserved.

Redistribution and use in source and binary forms, with or without 
modification, are permitted provided that the following conditions are met:

 - Redistributions of source code must retain the above copyright notice, 
   this list of conditions and the following disclaimer.
 - Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
 - Neither the name of the Geomatics and Cartographic Research Centre, 
   Carleton University nor the names of its contributors may be used to 
   endorse or promote products derived from this software without specific 
   prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE 
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE 
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR 
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF 
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS 
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN 
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) 
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE 
POSSIBILITY OF SUCH DAMAGE.

$Id: n2.couchDisplay.js 8441 2012-08-15 17:48:33Z jpfiset $
*/
;(function($,$n2){

// Localization
var _loc = function(str,args){ return $n2.loc(str,'nunaliit2-couch',args); };

function docCreationTimeSort(lhs, rhs) {
	var timeLhs = 0;
	var timeRhs = 0;
	
	if( lhs && lhs.doc && lhs.doc.nunaliit_created && lhs.doc.nunaliit_created.time ) {
		timeLhs = lhs.doc.nunaliit_created.time;
	}
	if( rhs && rhs.doc && rhs.doc.nunaliit_created && rhs.doc.nunaliit_created.time ) {
		timeRhs = rhs.doc.nunaliit_created.time;
	}
	
	if( timeLhs < timeRhs ) return -1;
	if( timeLhs > timeRhs ) return 1;
	return 0;
};

function startsWith(s, prefix) {
	var left = s.substr(0,prefix.length);
	return (left === prefix);
};

var defaultOptions = {
	documentSource: null
	,displayPanelName: null
	,showService: null // asynchronous resolver
	,editor: null
	,uploadService: null
	,serviceDirectory: null
	,postProcessDisplayFunction: null
	,displayRelatedInfoFunction: null
	,displayOnlyRelatedSchemas: false
	,displayBriefInRelatedInfo: false
	
	/*
	 * if defined, used by the map display logic to invoke a function to initiate 
	 * side panel display processing as a result of clicking a map feature.  
	 * 
	 * @return null => nothing done so continue with normal display processing; otherwise
	 *         display was done and the default clicked feature handling is bypassed.
	 */
	,translateCallback: null
	,classDisplayFunctions: {}
	,restrictAddRelatedButtonToLoggedIn: false
};	

$n2.couchDisplay = $n2.Class({
	
	options: null
	
	,currentFeature: null
	
	,createRelatedDocProcess: null
	
	,requestService: null
	
	,defaultSchema: null
	
	,postProcessDisplayFns: null
	
	,dispatchHandle: null
	
	,initialize: function(options_) {
		var _this = this;
		
		this.options = $n2.extend({}, defaultOptions, options_);
		
		// Post-process display functions
		var customService = this._getCustomService();
		this.postProcessDisplayFns = [];
		if( typeof(this.options.postProcessDisplayFunction) === 'function' ){
			this.postProcessDisplayFns.push(this.options.postProcessDisplayFunction);
		};
		if( customService ){
			var postProcessFns = customService.getOption('displayPostProcessFunctions');
			if( postProcessFns ){
				for(var i=0,e=postProcessFns.length;i<e;++i){
					if( typeof postProcessFns[i] === 'function' ){
						this.postProcessDisplayFns.push(postProcessFns[i]);
					};
				};
			};
		};

		var dispatcher = this._getDispatcher();
		if( dispatcher ) {
			this.dispatchHandle = dispatcher.getHandle('n2.couchDisplay');
			var f = function(msg){
				_this._handleDispatch(msg);
			};
			dispatcher.register(this.dispatchHandle, 'selected', f);
			dispatcher.register(this.dispatchHandle, 'searchResults', f);
			dispatcher.register(this.dispatchHandle, 'documentDeleted', f);
			dispatcher.register(this.dispatchHandle, 'authLoggedIn', f);
			dispatcher.register(this.dispatchHandle, 'authLoggedOut', f);
			dispatcher.register(this.dispatchHandle, 'editClosed', f);
			dispatcher.register(this.dispatchHandle, 'documentContentCreated', f);
			dispatcher.register(this.dispatchHandle, 'documentContentUpdated', f);
		};

		var requestService = this._getRequestService();
		if( requestService ){
			requestService.addDocumentListener(function(doc){
				_this._refreshDocument(doc);
				_this._populateWaitingDocument(doc);
			});
		};
		
		if( !this.options.displayRelatedInfoFunction ) {
			var flag = this._getBooleanOption('displayOnlyRelatedSchemas');
			if( flag ) {
				this.options.displayRelatedInfoFunction = function(opts_){
					_this._displayRelatedInfo(opts_);
				};
			} else {
				this.options.displayRelatedInfoFunction = function(opts_){
					_this._displayLinkedInfo(opts_);
				};
			};
		};
		
		this.createRelatedDocProcess = new $n2.couchRelatedDoc.CreateRelatedDocProcess({
			documentSource: this.options.documentSource
			,schemaRepository: this._getSchemaRepository()
			,uploadService: this.options.uploadService
			,showService: this._getShowService()
			,authService: this._getAuthService()
		});
	}

	// external
	,setSchema: function(schema) {
		this.defaultSchema = schema;
	}
	
	// external
	,addPostProcessDisplayFunction: function(fn){
		if( typeof(fn) === 'function' ){
			this.postProcessDisplayFns.push(fn);
		};
	}
	
	,_displayDocument: function($set, doc) {

		var _this = this;
		
		$set.empty();
		
		this._displayObject($set, doc, {
			onUpdated: function() {
				_this._displayDocument($set, doc);
			}
			,onDeleted: function() {
				$set.empty();
			}
		});
	}

	,_shouldSuppressNonApprovedMedia: function(){
		return this._getShowService().options.eliminateNonApprovedMedia;
	}

	,_shouldSuppressDeniedMedia: function(){
		return this._getShowService().options.eliminateDeniedMedia;
	}
	
	,_getDisplayDiv: function(){
		var divId = this.options.displayPanelName;
		return $('#'+divId);
	}
	
	,_getAuthService: function(){
		if( this.options.serviceDirectory ){
			return this.options.serviceDirectory.authService;
		};
		
		return null;
	}
	
	,_getShowService: function(){
		if( this.options.showService ){
			return this.options.showService;
		};
		
		return this.options.serviceDirectory.showService;
	}
	
	,_getRequestService: function(){
		return this.options.serviceDirectory.requestService;
	}
	
	,_getSchemaRepository: function(){
		var repository = null;
		if( this.options
		 && this.options.serviceDirectory ){
			repository = this.options.serviceDirectory.schemaRepository;
		};
		return repository;
	}
	
	,_displayObject: function($side, data, opt_) {
		var _this = this;
		
		var opt = $n2.extend({
			onUpdated: function(){ 
			}
			,onDeleted: function() {
			}
			,suppressContributionReferences: false
			,showContributionReplyButton: false
			,showAddContributionButton: false
			,showRelatedContributions: false
		},opt_);

		var docId = data._id;
		
		var $elem = $('<div class="couchDisplay_'+$n2.utils.stringToHtmlId(docId)+'"></div>');
		$side.append($elem);

		var $sElem = $('<div class="n2s_handleHover"></div>');
		$elem.append($sElem);
		
		this._getShowService().displayDocument($sElem, {
			onDisplayed: onDisplayed
		}, data);

		if( data.nunaliit_schema ) {
			var schemaRepository = _this._getSchemaRepository();
			if( schemaRepository ) {
				schemaRepository.getSchema({
					name: data.nunaliit_schema
					,onSuccess: function(schema) {
						continueDisplay(schema);
					}
					,onError: function(){
						continueDisplay(null);
					}
				});
				
			} else {
				continueDisplay(null);
			};
			
		} else {
			continueDisplay(null);
		};
		
		function continueDisplay(schema){
			_this._addAttachmentProgress($elem, data);
			
			_this._addButtons($elem, data, {
				schema: schema
				,related: true
				,reply: true
				,geom: true
				,edit: true
				,'delete': true
				,addLayer: true
			});
			
			var relatedInfoId = $n2.getUniqueId();
			var $div = $('<div id="'+relatedInfoId+'" class="couchDisplayRelated_'+$n2.utils.stringToHtmlId(data._id)+'"></div>');
			$elem.append($div);
			_this.options.displayRelatedInfoFunction({
				divId: relatedInfoId
				,doc: data
				,schema: schema
			});
		};
		
		function onDisplayed($sElem, data, schema, opt_){
			if( _this.options.classDisplayFunctions ) {
				for(var className in _this.options.classDisplayFunctions){
					var fn = _this.options.classDisplayFunctions[className];
					var jqCallback = eachFunctionForClass(className, fn, data, opt);
					$sElem.find('.'+className).each(jqCallback);
				};
			};
			
			// Perform post-process function 
			for(var i=0,e=_this.postProcessDisplayFns.length; i<e; ++i){
				var fn = _this.postProcessDisplayFns[i];
				fn(data, $sElem);
			};
		};

		function eachFunctionForClass(className, fn, data, opt){
			return function(){
				var $jq = $(this);
				fn(data, $jq, opt);
				$jq.removeClass(className);
			};
		};
	}
	
	,_addButtons: function($elem, data, opt_) {
		var _this = this;
		
		var opt = $n2.extend({
			schema: null
			,focus: false
			,related: false
			,reply: false
			,geom: false
			,edit: false
			,'delete': false
			,addLayer: false
		},opt_);

		var $buttons = $('<div></div>');
		$buttons.addClass('n2Display_buttons');
		$buttons.addClass('n2Display_buttons_'+$n2.utils.stringToHtmlId(data._id));
		$elem.append( $buttons );
		
		var optionClass = 'options';
		if( opt.focus ) optionClass += '_focus';
		if( opt.edit ) optionClass += '_edit';
		if( opt.related ) optionClass += '_related';
		if( opt.reply ) optionClass += '_reply';
		if( opt.geom ) optionClass += '_geom';
		if( opt['delete'] ) optionClass += '_delete';
		if( opt.addLayer ) optionClass += '_addLayer';
		$buttons.addClass(optionClass);

		var opts = {
			doc: data
			,schema: opt.schema
			,focus: opt.focus
			,edit: opt.edit
			,related: opt.related
			,reply: opt.reply
			,geom: opt.geom
			,addLayer: opt.addLayer
		};
		opts['delete'] = opt['delete'];
		this._displayButtons($buttons, opts);
	}
	
	,_refreshButtons: function($elem){
		var _this = this;
		
		var docId = null;
		var fFocus = false;
		var fEdit = false;
		var fRelated = false;
		var fReply = false;
		var fGeom = false;
		var fDelete = false;
		var fAddLayer = false;
		var classAttr = $elem.attr('class');
		var classes = classAttr.split(' ');
		for(var i=0,e=classes.length; i<e; ++i){
			var className = classes[i];
			if( startsWith(className,'n2Display_buttons_') ){
				var escapedDocId = className.substr('n2Display_buttons_'.length);
				docId = $n2.utils.unescapeHtmlId(escapedDocId);
				
			} else if( startsWith(className,'options') ){
				var options = className.split('_');
				for(var j=0,k=options.length; j<k; ++j){
					var o = options[j];
					if( 'focus' === o ){ fFocus = true; }
					else if( 'edit' === o ){ fEdit = true; }
					else if( 'related' === o ){ fRelated = true; }
					else if( 'reply' === o ){ fReply = true; }
					else if( 'geom' === o ){ fGeom = true; }
					else if( 'addLayer' === o ){ fAddLayer = true; }
					else if( 'delete' === o ){ fDelete = true; };
				};
			};
		};
		
		if( docId ){
			this.options.documentSource.getDocument({
				docId: docId
				,onSuccess: getSchema
				,onError:function(){}
			});
		};
		
		function getSchema(doc){
			if( doc.nunaliit_schema ) {
				var schemaRepository = _this._getSchemaRepository();
				if( schemaRepository ) {
					schemaRepository.getSchema({
						name: doc.nunaliit_schema
						,onSuccess: function(schema) {
							drawButtons(doc,schema);
						}
						,onError: function(){
							drawButtons(doc,null);
						}
					});
					
				} else {
					drawButtons(doc,null);
				};
				
			} else {
				drawButtons(doc,null);
			};
		};
		
		function drawButtons(doc,schema){
			var opts = {
				doc: doc
				,schema: schema
				,focus: fFocus
				,edit: fEdit
				,related: fRelated
				,reply: fReply
				,geom: fGeom
				,addLayer: fAddLayer
			};
			opts['delete'] = fDelete;
			$elem.empty();
			_this._displayButtons($elem, opts);
		};
	}
	
	,_displayButtons: function($buttons, opt){

		var _this = this;
		var data = opt.doc;
		var schema = opt.schema;
		
		var firstButton = true;
		var dispatcher = this._getDispatcher();
		var schemaRepository = _this._getSchemaRepository();

 		// Show 'focus' button
 		if( opt.focus 
 		 && data
 		 && data._id ) {
 			if( firstButton ) {
 				firstButton = false;
 			} else {
 				$buttons.append( $('<span>&nbsp;</span>') );
 			};
			var $focusButton = $('<a href="#"></a>');
			var focusText = _loc('More Info');
			$focusButton.text( focusText );
			$buttons.append($focusButton);
			$focusButton.click(function(){
				_this._dispatch({
					type:'userSelect'
					,docId: data._id
				})
				return false;
			});
			addClasses($focusButton, focusText);
 		};

 		// Show 'edit' button
 		if( opt.edit 
 		 && $n2.couchMap.canEditDoc(data) ) {
 			if( firstButton ) {
 				firstButton = false;
 			} else {
 				$buttons.append( $('<span>&nbsp;</span>') );
 			};
			var $editButton = $('<a href="#"></a>');
			var editText = _loc('Edit');
			$editButton.text( editText );
			$buttons.append($editButton);
			$editButton.click(function(){
				_this._performDocumentEdit(data, opt);
				return false;
			});
			addClasses($editButton, editText);
 		};

 		// Show 'delete' button
 		if( opt['delete'] 
 		 && $n2.couchMap.canDeleteDoc(data) ) {
 			if( firstButton ) {
 				firstButton = false;
 			} else {
 				$buttons.append( $('<span>&nbsp;</span>') );
 			};
			var $deleteButton = $('<a href="#"></a>');
			var deleteText = _loc('Delete');
			$deleteButton.text( deleteText );
			$buttons.append($deleteButton);
			$deleteButton.click(function(){
				_this._performDocumentDelete(data, opt);
				return false;
			});
			addClasses($deleteButton, deleteText);
 		};
		
 		// Show 'add related' button
		if( opt.related
		 && opt.schema
		 && opt.schema.relatedSchemaNames 
		 && opt.schema.relatedSchemaNames.length
		 ) {
			var showRelatedButton = true;
			var flag = this._getBooleanOption('restrictAddRelatedButtonToLoggedIn');
			if( flag ){
				var sessionContext = $n2.couch.getSession().getContext();
				if( !sessionContext || !sessionContext.name ) {
					showRelatedButton = false;
				};
			};
			
			if( showRelatedButton ) {
	 			if( firstButton ) {
	 				firstButton = false;
	 			} else {
	 				$buttons.append( $('<span>&nbsp;</span>') );
	 			};
//				var $addRelatedButton = $('<a href="#"></a>');
//				var addRelatedText = _loc('Add Related Item');
//				$addRelatedButton.text( addRelatedText );
//				$buttons.append($addRelatedButton);
//				$addRelatedButton.click(function(){
//					_this._addRelatedDocument(data._id, opt.schema.relatedSchemaNames);
//					return false;
//				});
//				addClasses($addRelatedButton, 'add_related_item');

	 			var selectId = $n2.getUniqueId();
				var $addRelatedButton = $('<select>')
					.attr('id',selectId)
					.appendTo($buttons);
				$('<option>')
					.text( _loc('Add Related Item') )
					.val('')
					.appendTo($addRelatedButton);
				for(var i=0,e=opt.schema.relatedSchemaNames.length; i<e; ++i){
					var schemaName = opt.schema.relatedSchemaNames[i];
					$('<option>')
						.text(schemaName)
						.val(schemaName)
						.appendTo($addRelatedButton);
					
					if( schemaRepository ){
						schemaRepository.getSchema({
							name: schemaName
							,onSuccess: function(schema){
								$('#'+selectId).find('option').each(function(){
									var $option = $(this);
									if( $option.val() === schema.name
									 && schema.label ){
										$option.text(schema.label);
									};
								});
							}
						});
					};
				};
				
				$addRelatedButton.change(function(){
					var val = $(this).val();
					$(this).val('');
					_this._addRelatedDocument(data._id, [val]);
					return false;
				});
				addClasses($addRelatedButton, 'add_related_item');
				
				$addRelatedButton.menuselector();
			};
		};
		
 		// Show 'reply' button
		if( opt.reply
		 && opt.schema
		 && opt.schema.options 
		 && opt.schema.options.enableReplies
		 ) {
			var showReplyButton = true;
			var flag = this._getBooleanOption('restrictReplyButtonToLoggedIn');
			if( flag ){
				var sessionContext = $n2.couch.getSession().getContext();
				if( !sessionContext || !sessionContext.name ) {
					showReplyButton = false;
				};
			};
			
			if( showReplyButton ) {
	 			if( firstButton ) {
	 				firstButton = false;
	 			} else {
	 				$buttons.append( $('<span>&nbsp;</span>') );
	 			};
				var $replyButton = $('<a href="#"></a>');
				var replyText = _loc('Reply');
				$replyButton.text( replyText );
				$buttons.append($replyButton);
				$replyButton.click(function(){
					_this._replyToDocument(data, opt.schema);
					return false;
				});
				addClasses($replyButton, 'reply');
			};
		};
		
 		// Show 'find on map' button
		if( dispatcher 
		 && opt.geom
		 && data 
		 && data.nunaliit_geom 
		 && dispatcher.isEventTypeRegistered('findOnMap')
		 ) {
			// Check iff document can be displayed on a map
			var showFindOnMapButton = false;
			if( data.nunaliit_layers && data.nunaliit_layers.length > 0 ) {
				var m = {
					type:'mapGetLayers'
					,layers:{}
				};
				dispatcher.synchronousCall(this.dispatchHandle,m);
				for(var i=0,e=data.nunaliit_layers.length; i<e; ++i){
					var layerId = data.nunaliit_layers[i];
					if( m.layers[layerId] ){
						showFindOnMapButton = true;
					};
				};
			};

			if( showFindOnMapButton ) {
	 			if( firstButton ) {
	 				firstButton = false;
	 			} else {
	 				$buttons.append( $('<span>&nbsp;</span>') );
	 			};
				var $findGeomButton = $('<a href="#"></a>');
				var findGeomText = _loc('Find on Map');
				$findGeomButton.text( findGeomText );
				$buttons.append($findGeomButton);
	
				var x = (data.nunaliit_geom.bbox[0] + data.nunaliit_geom.bbox[2]) / 2;
				var y = (data.nunaliit_geom.bbox[1] + data.nunaliit_geom.bbox[3]) / 2;
				
				$findGeomButton.click(function(){
					// Check if we need to turn a layer on
					var visible = false;
					var layerIdToTurnOn = null;
					var m = {
							type:'mapGetLayers'
							,layers:{}
						};
					dispatcher.synchronousCall(_this.dispatchHandle,m);
					for(var i=0,e=data.nunaliit_layers.length; i<e; ++i){
						var layerId = data.nunaliit_layers[i];
						if( m.layers[layerId] ){
							if( m.layers[layerId].visible ){
								visible = true;
							} else {
								layerIdToTurnOn = layerId;
							};
						};
					};

					// Turn on layer
					if( !visible ){
						_this._dispatch({
							type: 'setMapLayerVisibility'
							,layerId: layerIdToTurnOn
							,visible: true
						});
					};
					
					// Move map and display feature 
					_this._dispatch({
						type: 'findOnMap'
						,fid: data._id
						,srsName: 'EPSG:4326'
						,x: x
						,y: y
					});
					
					return false;
				});
				addClasses($findGeomButton, findGeomText);
			};
		};

		// Show 'Add Layer' button
		if( opt.addLayer
		 && data
		 && data.nunaliit_layer_definition
		 && dispatcher
		 && dispatcher.isEventTypeRegistered('addLayerToMap')
		 ) {
 			if( firstButton ) {
 				firstButton = false;
 			} else {
 				$buttons.append( $('<span>&nbsp;</span>') );
 			};
			var $addLayerButton = $('<a href="#"></a>');
			var btnText = _loc('Add Layer');
			$addLayerButton.text( btnText );
			$buttons.append($addLayerButton);

			var layerDefinition = data.nunaliit_layer_definition;
			var layerId = layerDefinition.id;
			if( !layerId ){
				layerId = data._id;
			};
			var layerDef = {
				name: layerDefinition.name
				,type: 'couchdb'
				,options: {
					layerName: layerId
					,documentSource: this.options.documentSource
				}
			};
			
			$addLayerButton.click(function(){
				_this._dispatch({
					type: 'addLayerToMap'
					,layer: layerDef
					,options: {
						setExtent: {
							bounds: layerDefinition.bbox
							,crs: 'EPSG:4326'
						}
					}
				});
				return false;
			});
			addClasses($addLayerButton, btnText);
		};

		/**
		 * Generate and insert css classes for the generated element, based on the given tag.
		 * @param elem the jQuery element to be modified
		 * @param tag the string tag to be used in generating classes for elem
		 */
		function addClasses(elem, tag) {
			elem.addClass('nunaliit_form_link');
			
			var compactTag = tag;
			var spaceIndex = compactTag.indexOf(' ');
			while (-1 !== spaceIndex) {
				compactTag = compactTag.slice(0,spaceIndex) + '_' +
					compactTag.slice(spaceIndex + 1);
				spaceIndex = compactTag.indexOf(' ');
			};
			elem.addClass('nunaliit_form_link_' + compactTag.toLowerCase());
		};
		
	}
	
	,_addAttachmentProgress: function($elem, data){
		var $progress = $('<div></div>')
			.addClass('n2Display_attProgress')
			.addClass('n2Display_attProgress_'+$n2.utils.stringToHtmlId(data._id) )
			.appendTo( $elem );
		
		this._refreshAttachmentProgress($progress, data);
	}
	
	,_refreshAttachmentProgress: function($progress, data){

		var status = null;
		
		$progress.empty();
		
		// Find an attachment which is in progress
		if( data.nunaliit_attachments 
		 && data.nunaliit_attachments.files ){
			for(var attName in data.nunaliit_attachments.files){
				var att = data.nunaliit_attachments.files[attName];
				
				// Skip non-original attachments
				if( !att.source ){
					if( att.status 
					 && 'attached' !== att.status ){
						// OK, progress must be reported. Accumulate
						// various status since there could be more than
						// one attachment.
						if( !status ){
							status = {};
						};
						status[att.status] = true;
					};
				};
			};
		};

		// Report status
		if( status ){
			var $outer = $('<div></div>')
				.addClass('n2Display_attProgress_outer')
				.appendTo($progress);

			$('<div></div>')
				.addClass('n2Display_attProgress_icon')
				.appendTo($outer);
		
			if( status['waiting for approval'] ){
				$outer.addClass('n2Display_attProgress_waiting');
				
				$('<div></div>')
					.addClass('n2Display_attProgress_message')
					.text( _loc('Attachment is waiting for approval') )
					.appendTo($outer);
				
			} else if( status['denied'] ){
				$outer.addClass('n2Display_attProgress_denied');
				
				$('<div></div>')
					.addClass('n2Display_attProgress_message')
					.text( _loc('Attachment has been denied') )
					.appendTo($outer);
				
			} else {
				// Robot is working
				$outer.addClass('n2Display_attProgress_busy');
				
				$('<div></div>')
					.addClass('n2Display_attProgress_message')
					.text( _loc('Attachment is being processed') )
					.appendTo($outer);
			};

			$('<div></div>')
				.addClass('n2Display_attProgress_outer_end')
				.appendTo($outer);
		};
	}
	
	,_displayRelatedInfo: function(opts_){
		var opts = $n2.extend({
			divId: null
			,div: null
			,doc: null
			,schema: null
		},opts_);
		
		var _this = this;
		var doc = opts.doc;
		var docId = doc._id;
		var schema = opts.schema;
		
		var $elem = opts.div;
		if( ! $elem ) {
			$elem = $('#'+opts.divId);
		};
		if( ! $elem.length) {
			return;
		};
		
		if( !schema 
		 || !schema.relatedSchemaNames
		 || !schema.relatedSchemaNames.length ){
			return;
		};
		
		// Make a map of related schemas
		var schemaInfoByName = {};
		for(var i=0,e=schema.relatedSchemaNames.length; i<e; ++i){
			var relatedSchemaName = schema.relatedSchemaNames[i];
			schemaInfoByName[relatedSchemaName] = { docIds:[] };
		};

		// Get references
		this._getAllReferences({
			doc: doc
			,onSuccess: showSections
		});

		function showSections(refInfo){
			// Accumulate document ids under the associated schema
			for(var requestDocId in refInfo){
				if( refInfo[requestDocId].exists 
				 && refInfo[requestDocId].reverse
				 && refInfo[requestDocId].schema ) {
					var schemaName = refInfo[requestDocId].schema;
					var schemaInfo = schemaInfoByName[schemaName];
					if( schemaInfo ){
						schemaInfo.docIds.push(requestDocId);
					};
				};
			};

			// Add section with related documents
			for(var schemaName in schemaInfoByName){
				var schemaInfo = schemaInfoByName[schemaName];
				if( schemaInfo.docIds.length > 0 ) {
					var contId = $n2.getUniqueId();
					var $div = $('<div id="'+contId+'"></div>');
					$elem.append($div);
	
					var relatedDocIds = schemaInfo.docIds;
					
					_this._displayRelatedDocuments(contId, schemaName, relatedDocIds);
				};
			};
		};
	}
	
	,_displayLinkedInfo: function(opts_){
		var opts = $n2.extend({
			divId: null
			,div: null
			,doc: null
			,schema: null
		},opts_);
		
		var _this = this;
		var doc = opts.doc;
		var docId = doc._id;
		
		var $elem = opts.div;
		if( ! $elem ) {
			$elem = $('#'+opts.divId);
		};
		if( ! $elem.length) {
			return;
		};

		// Get references
		this._getAllReferences({
			doc: doc
			,onSuccess: showSections
		});

		function showSections(refInfo){
			// Accumulate document ids under the associated schema
			var relatedDocsFromSchemas = {};
			var uncategorizedDocIds = [];
			for(var requestDocId in refInfo){
				if( refInfo[requestDocId].exists ) {
					var schemaName = refInfo[requestDocId].schema;
					
					if( schemaName ) {
						if( !relatedDocsFromSchemas[schemaName] ) {
							relatedDocsFromSchemas[schemaName] = {
								docIds: []
							};
						};
						relatedDocsFromSchemas[schemaName].docIds.push(requestDocId);
					} else {
						uncategorizedDocIds.push(requestDocId);
					};
				};
			};

			// Add section with related documents
			for(var schemaName in relatedDocsFromSchemas){
				var contId = $n2.getUniqueId();
				var $div = $('<div id="'+contId+'"></div>');
				$elem.append($div);

				var relatedDocIds = relatedDocsFromSchemas[schemaName].docIds;
				
				_this._displayRelatedDocuments(contId, schemaName, relatedDocIds);
			};
			
			// Add uncategorized
			if( uncategorizedDocIds.length > 0 ) {
				var contId = $n2.getUniqueId();
				var $div = $('<div id="'+contId+'"></div>');
				$elem.append($div);

				_this._displayRelatedDocuments(contId, null, uncategorizedDocIds);
			};
		};
	}
	
	,_displayRelatedDocuments: function(contId, relatedSchemaName, relatedDocIds){
		var _this = this;
		var $container = $('#'+contId);
		
		if( !relatedDocIds || relatedDocIds.length < 1 ) {
			$container.remove();
			return;
		};
		
		//legacyDisplay();
		blindDisplay();
		
		function blindDisplay(){

			var blindId = $n2.getUniqueId();
			var $blindWidget = $('<div id="'+blindId+'" class="_n2DocumentListParent"><h3></h3><div style="padding-left:0px;padding-right:0px;"></div></div>');
			$container.append($blindWidget);
			var bw = $n2.blindWidget($blindWidget,{
				data: relatedDocIds
				,onBeforeOpen: beforeOpen
			});
			bw.setHtml('<span class="_n2DisplaySchemaName"></span> (<span class="_n2DisplayDocCount"></span>)');
			if( null == relatedSchemaName ) {
				$blindWidget.find('._n2DisplaySchemaName').text( _loc('Uncategorized') );
			} else {
				$blindWidget.find('._n2DisplaySchemaName').text(relatedSchemaName);
			};
			$blindWidget.find('._n2DisplayDocCount').text(''+relatedDocIds.length);
			
			var schemaRepository = _this._getSchemaRepository();
			if( schemaRepository && relatedSchemaName ){
				schemaRepository.getSchema({
					name: relatedSchemaName
					,onSuccess: function(schema){
						var $blindWidget = $('#'+blindId);
						$blindWidget.find('._n2DisplaySchemaName').text( _loc(schema.getLabel()) );
					}
				});
			};

			function beforeOpen(info){
				var $div = info.content;
				
				var $dataloaded = $div.find('.___n2DataLoaded');
				if( $dataloaded.length > 0 ) {
					// nothing to do
					return;
				};
				
				// Fetch data
				var docIds = info.data;
				$div.empty();
				$div.append( $('<div class="___n2DataLoaded" style="display:none;"></div>') );
				for(var i=0,e=docIds.length; i<e; ++i){
					var docId = docIds[i];
					
					var $docWrapper = $('<div></div>');
					$div.append($docWrapper);
					if ( 0 === i ) { // mark first and last one
						$docWrapper.addClass('_n2DocumentListStart');
					};
					if ( (e-1) === i ) {
						$docWrapper.addClass('_n2DocumentListEnd');
					};
					$docWrapper
						.addClass('_n2DocumentListEntry')
						.addClass('_n2DocumentListEntry_'+$n2.utils.stringToHtmlId(docId))
						.addClass('olkitSearchMod2_'+(i%2))
						.addClass('n2SupressNonApprovedMedia_'+$n2.utils.stringToHtmlId(docId))
						.addClass('n2SupressDeniedMedia_'+$n2.utils.stringToHtmlId(docId))
						;
					
					var $doc = $('<div></div>');
					$docWrapper.append($doc);

					if( _this._getShowService() ) {
						var flag = _this._getBooleanOption('displayBriefInRelatedInfo');
						if( flag ){
							_this._getShowService().printBriefDescription($doc,docId);
						} else {
							_this._getShowService().printDocument($doc,docId);
						};
					} else {
						$doc.text(docId);
					};
					if( _this._getRequestService() ) {
						var $progressDiv = $('<div class="n2Display_attProgress n2Display_attProgress_'+$n2.utils.stringToHtmlId(docId)+'"></div>');
						$docWrapper.append($progressDiv);

						var $buttonDiv = $('<div class="displayRelatedButton displayRelatedButton_'+$n2.utils.stringToHtmlId(docId)+'"></div>');
						$docWrapper.append($buttonDiv);
						
						_this._getRequestService().requestDocument(docId);
					};
				};
			};
		};
	}

	,_addRelatedDocument: function(docId, relatedSchemaNames){
		var _this = this;
		
		this.createRelatedDocProcess.addRelatedDocumentFromSchemaNames({
			docId: docId
			,relatedSchemaNames: relatedSchemaNames
			,onSuccess: function(docId){
//				_this._RefreshClickedFeature();
			}
		});
	}
	
	,_getAllReferences: function(opts_){
		var opts = $n2.extend({
			doc: null
			,onSuccess: function(refInfo){}
			,onError: function(err){}
		},opts_);
		
		var _this = this;
		
		var doc = opts.doc;
		
		// Keep track of docIds and associated schemas
		var refInfo = {};
		
		// Compute forward references
		var references = [];
		$n2.couchUtils.extractLinks(doc, references);
		for(var i=0, e=references.length; i<e; ++i){
			var linkDocId = references[i].doc;
			if( !refInfo[linkDocId] ){
				refInfo[linkDocId] = {};
			};
			refInfo[linkDocId].forward = true;
		};
		
		// Get identifiers of all documents that reference this one
		this.options.documentSource.getReferencesFromId({
			docId: doc._id
			,onSuccess: function(refIds){
				for(var i=0,e=refIds.length;i<e;++i){
					var id = refIds[i];
					if( !refInfo[id] ){
						refInfo[id] = {};
					};
					refInfo[id].reverse = true;
				};
				
				getRefSchemas();
			}
			,onError: getRefSchemas
		});

		function getRefSchemas(){
			var requestDocIds = [];
			for(var requestDocId in refInfo){
				requestDocIds.push(requestDocId);
			};

			_this.options.documentSource.getDocumentInfoFromIds({
				docIds: requestDocIds
				,onSuccess: function(infos){
					for(var i=0,e=infos.length;i<e;++i){
						var requestDocId = infos[i].id;
						
						refInfo[requestDocId].exists = true;
						if( infos[i].schema ) {
							refInfo[requestDocId].schema = infos[i].schema;
						};
					};
					
					opts.onSuccess(refInfo);
				}
				,onError: opts.onError
			});
		};
	}

	,_replyToDocument: function(doc, schema){
		var _this = this;
		
		this.createRelatedDocProcess.replyToDocument({
			doc: doc
			,schema: schema
			,onSuccess: function(docId){
			}
		});
	}
	
	,_refreshDocument: function(doc){

		var _this = this;
		
		// Retrieve schema document
		var schemaRepository = this._getSchemaRepository();
		if( doc.nunaliit_schema && schemaRepository ) {
			schemaRepository.getSchema({
				name: doc.nunaliit_schema
				,onSuccess: function(schema) {
					refreshDocWithSchema(doc, schema);
				}
				,onError: function(){
					refreshDocWithSchema(doc, null);
				}
			});
		} else {
			refreshDocWithSchema(doc, null);
		};
	
		function refreshDocWithSchema(doc, schema){
			var docId = doc._id;
			
			$('.displayRelatedButton_'+$n2.utils.stringToHtmlId(docId)).each(function(){
				var $buttonDiv = $(this);
				$buttonDiv.empty();
				_this._addButtons($buttonDiv, doc, {
					schema: schema
					,focus: true
					,geom: true
					,reply: true
				});
			});
			
			$('.n2Display_attProgress_'+$n2.utils.stringToHtmlId(docId)).each(function(){
				var $progress = $(this);
				_this._refreshAttachmentProgress($progress,doc);
			});
			
			if( _this._shouldSuppressNonApprovedMedia() ){
				if( $n2.couchMap.documentContainsMedia(doc) 
				 && false == $n2.couchMap.documentContainsApprovedMedia(doc) ) {
					$('.n2SupressNonApprovedMedia_'+$n2.utils.stringToHtmlId(docId)).each(function(){
						var $div = $(this);
						var $parent = $div.parent();
						$div.remove();
						_this._fixDocumentList($parent);
					});
				};
			} else if( _this._shouldSuppressDeniedMedia() ){
				if( $n2.couchMap.documentContainsMedia(doc) 
				 && $n2.couchMap.documentContainsDeniedMedia(doc) ) {
					$('.n2SupressDeniedMedia_'+$n2.utils.stringToHtmlId(docId)).each(function(){
						var $div = $(this);
						var $parent = $div.parent();
						$div.remove();
						_this._fixDocumentList($parent);
					});
				};
			};
		};
	}
	
	,_populateWaitingDocument: function(doc){
		var _this = this;
		
		if( doc ) {
			var docId = doc._id;
			var escaped = $n2.utils.stringToHtmlId(docId);
			var cName = 'couchDisplayWait_'+escaped;
			$('.'+cName).each(function(){
				var $set = $(this);
				$set
					.removeClass(cName)
					.addClass('couchDisplayAdded_'+escaped);
				_this._displayDocument($set, doc);
			});
		};
	}
	
	,_fixDocumentList: function($elem){
		if( $elem.hasClass('_n2DocumentListParent') ) {
			var $relatedDiv = $elem;
		} else {
			$relatedDiv = $elem.parents('._n2DocumentListParent');
		};
		if( $relatedDiv.length > 0 ){
			var $docDiv = $relatedDiv.find('._n2DocumentListEntry');
			var count = $docDiv.length;
			$relatedDiv.find('._n2DisplayDocCount').text(''+count);
			
			$docDiv.each(function(i){
				var $doc = $(this);
				$doc.removeClass('olkitSearchMod2_0');
				$doc.removeClass('olkitSearchMod2_1');
				$doc.addClass('olkitSearchMod2_'+(i%2));
			});
		};
	}
	
	,_performDocumentEdit: function(data, options_) {
		this._dispatch({
			type: 'editInitiate'
			,docId: data._id
			,doc: data
		});
	}
	
	,_performDocumentDelete: function(data, options_) {
		var _this = this;

		if( confirm( _loc('You are about to delete this document. Do you want to proceed?') ) ) {
			this.options.documentSource.deleteDocument({
				doc: data
				,onSuccess: function() {
					if( options_.onDeleted ) {
						options_.onDeleted();
					};
				}
			});
		};
	}
	
	,_displayDocumentId: function($set, docId) {

		var _this = this;
		
		$set.empty();

		this.options.documentSource.getDocument({
			docId: docId
			,onSuccess: function(doc) {
				_this._displayDocument($set, doc);
			}
			,onError: function(err) {
				$set.empty();
				$('<div>')
					.addClass('couchDisplayWait_'+$n2.utils.stringToHtmlId(docId))
					.text( _loc('Unable to retrieve document') )
					.appendTo($set);
			}
		});
	}
	
	,_handleDispatch: function(msg){
		var _this = this;
		
		var $div = this._getDisplayDiv();
		if( $div.length < 1 ){
			// No longer displaying. Un-register this event.
			dispatcher.deregister(addr);
			return;
		};
		
		// Selected document
		if( msg.type === 'selected' ) {
			if( msg.doc ) {
				this._displayDocument($div, msg.doc);
				
			} else if( msg.docId ) {
				this._displayDocumentId($div, msg.docId);
				
			} else if( msg.docs ) {
				this._displayMultipleDocuments($div, msg.docs);
				
			} else if( msg.docIds ) {
				$div.empty();
				this._displayMultipleDocumentIds($div, msg.docIds)
			};
			
		} else if( msg.type === 'searchResults' ) {
			this._displaySearchResults(msg.results);
			
		} else if( msg.type === 'documentDeleted' ) {
			var docId = msg.docId;
			this._handleDocumentDeletion(docId);
			
		} else if( msg.type === 'authLoggedIn' 
			|| msg.type === 'authLoggedOut' ) {
			$('.n2Display_buttons').each(function(){
				var $elem = $(this);
				_this._refreshButtons($elem);
			});
			
		} else if( msg.type === 'editClosed' ) {
			var deleted = msg.deleted;
			if( !deleted ) {
				var doc = msg.doc;
				if( doc ) {
					this._displayDocument($div, doc);
				};
			};
			
		} else if( msg.type === 'documentContentCreated' ) {
			this._handleDocumentCreation(msg.doc);
			this._populateWaitingDocument(msg.doc);
			
		} else if( msg.type === 'documentContentUpdated' ) {
			this._refreshDocument(msg.doc);
			this._populateWaitingDocument(msg.doc);
		};
	}
	
	,_displayMultipleDocuments: function($container, docs) {

		var _this = this;
		
		var $list = $('<div class="_n2DocumentListParent"></div>');
		$container.append($list);
		
		for(var i=0,e=docs.length; i<e; ++i) {
			var doc = docs[i];
			
			var $div = $('<div></div>')
				.addClass('_n2DocumentListEntry')
				.addClass('_n2DocumentListEntry_'+$n2.utils.stringToHtmlId(docId))
				.addClass('olkitSearchMod2_'+(i%2))
				.addClass('n2SupressNonApprovedMedia_'+$n2.utils.stringToHtmlId(docId))
				.addClass('n2SupressDeniedMedia_'+$n2.utils.stringToHtmlId(docId))
				;
			$list.append($div);

			var $contentDiv = $('<div class="n2s_handleHover"></div>');
			$div.append($contentDiv);
			this._getShowService().displayBriefDescription($contentDiv, {}, doc);

			var $buttonDiv = $('<div></div>');
			$div.append($buttonDiv);
			this._addButtons($buttonDiv, doc, {focus:true,geom:true});
		};
	}

	,_displayMultipleDocumentIds: function($container, docIds) {

		var _this = this;
		
		var $list = $('<div class="_n2DocumentListParent"></div>');
		$container.append($list);
		
		for(var i=0,e=docIds.length; i<e; ++i){
			var docId = docIds[i];
			
			var $div = $('<div></div>')
				.addClass('_n2DocumentListEntry')
				.addClass('_n2DocumentListEntry_'+$n2.utils.stringToHtmlId(docId))
				.addClass('olkitSearchMod2_'+(i%2))
				.addClass('n2SupressNonApprovedMedia_'+$n2.utils.stringToHtmlId(docId))
				.addClass('n2SupressDeniedMedia_'+$n2.utils.stringToHtmlId(docId))
				;
			$list.append($div);

			var $contentDiv = $('<div class="n2s_handleHover"></div>');
			$div.append($contentDiv);
			this._getShowService().printBriefDescription($contentDiv, docId);
			
			if( this._getRequestService() ) {
				var $progressDiv = $('<div class="n2Display_attProgress n2Display_attProgress_'+$n2.utils.stringToHtmlId(docId)+'"></div>');
				$div.append($progressDiv);

				var $buttonDiv = $('<div class="displayRelatedButton displayRelatedButton_'+$n2.utils.stringToHtmlId(docId)+'"></div>');
				$div.append($buttonDiv);
				
				this._getRequestService().requestDocument(docId);
			};
		};
	}
	
	,_displaySearchResults: function(results){
		var ids = [];
		if( results && results.sorted && results.sorted.length ) {
			for(var i=0,e=results.sorted.length; i<e; ++i){
				ids.push(results.sorted[i].id);
			};
		};
		var $div = this._getDisplayDiv();
		$div.empty();
		if( ids.length < 1 ) {
			$div.append( $('<div>'+_loc('Search results empty')+'</div>') );
		} else {
			var $results = $('<div class="n2_search_result"></div>')
				.appendTo($div);
			this._displayMultipleDocumentIds($results, ids);
		};
	}
	
	,_getCustomService: function(){
		var cs = null;
		if( this.options.serviceDirectory 
		 && this.options.serviceDirectory.customService ) {
			cs = this.options.serviceDirectory.customService;
		};
		return cs;
	}
	
	,_getDispatcher: function(){
		var d = null;
		if( this.options.serviceDirectory 
		 && this.options.serviceDirectory.dispatchService ) {
			d = this.options.serviceDirectory.dispatchService;
		};
		return d;
	}
	
	,_dispatch: function(m){
		var dispatcher = this._getDispatcher();
		if( dispatcher ) {
			var h = dispatcher.getHandle('n2.couchDisplay');
			dispatcher.send(h,m);
		};
	}
	
	,_handleDocumentDeletion: function(docId){
		var _this = this;
		
		// Main document displayed
		var $elems = $('.couchDisplay_'+$n2.utils.stringToHtmlId(docId));
		$elems.remove();
		
		// Document waiting to be displayed
		var $elems = $('.couchDisplayWait_'+$n2.utils.stringToHtmlId(docId));
		$elems.remove();
		
		// Documents in list
		var $entries = $('._n2DocumentListEntry_'+$n2.utils.stringToHtmlId(docId));
		$entries.each(function(){
			var $entry = $(this);
			var $p = $entry.parent();
			$entry.remove();
			_this._fixDocumentList($p);
		});
		
	}
	
	,_handleDocumentCreation: function(doc){
		var _this = this;
		
		// Find all documents referenced by this one
		var links = $n2.couchGeom.extractLinks(doc);
		for(var i=0,e=links.length;i<e;++i){
			var refDocId = links[i].doc;
			if( refDocId ){
				// Check if we have a related document section displayed for
				// this referenced document
				var $elems = $('.couchDisplayRelated_'+$n2.utils.stringToHtmlId(refDocId));
				if( $elems.length > 0 ){
					// We must redisplay this related info section
					refreshRelatedInfo(refDocId, $elems);
				};
			};
		};

		function refreshRelatedInfo(docId, $elems) {
			// Get document
			var request = _this._getRequestService();
			if( request ){
				request.requestDocument(docId,function(d){
					loadedData(d, $elems);
				});
			};
		};
		
		function loadedData(data, $elems) {
			// Get schema
			var schemaName = data.nunaliit_schema ? data.nunaliit_schema : null;
			var schemaRepository = _this._getSchemaRepository();
			if( schemaName && schemaRepository ) {
				schemaRepository.getSchema({
					name: schemaName
					,onSuccess: function(schema) {
						loadedSchema(data, schema, $elems);
					}
					,onError: function(){
						loadedSchema(data, null, $elems);
					}
				});
			} else {
				loadedSchema(data, null, $elems);
			};
		};
		
		function loadedSchema(data, schema, $elems){
			$elems.each(function(){
				var $e = $(this);
				// Refresh
				$e.empty();
				_this.options.displayRelatedInfoFunction({
					div: $e
					,doc: data
					,schema: schema
				});
			});
		};
	}
	
	/*
	 * Get a boolean option based on a name and return it. Defaults
	 * to false. If the option is found set in either the options map
	 * or the custom service, then the result is true.
	 */
	,_getBooleanOption: function(optionName){
		var flag = false;
		
		if( this.options[optionName] ){
			flag = true;
		};
		
		var cs = this._getCustomService();
		if( cs && !flag ){
			var o = cs.getOption(optionName);
			if( o ){
				flag = true;
			};
		};
		
		return flag;
	}
});

// Exports
$.olkitDisplay = null; 

})(jQuery,nunaliit2);
