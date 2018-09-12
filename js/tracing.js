/**
 * Adapted (heavily) from WebAudio inspector extension by Google.
 *
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var AudioPipes = window.AudioPipes || {};


// JanM: switch to google closure compiler at some point.
audion = {
  entryPoints: {
    ExtensionTag: {
      ToTracing: 'ToTracing',
      FromTracing: 'FromTracing'
    }
  },
  messaging: {
    MessageType: {
      NODE_CREATED:'NODE_CREATED',
      CONTEXT_CREATED:'CONTEXT_CREATED',
      AUDIO_NODE_PROPERTIES_UPDATE:'AUDIO_NODE_PROPERTIES_UPDATE',
      NODE_TO_NODE_CONNECTED:'NODE_TO_NODE_CONNECTED',
      NODE_TO_PARAM_CONNECTED:'NODE_TO_PARAM_CONNECTED',
      ALL_DISCONNECTED:'ALL_DISCONNECTED',
      NODE_FROM_NODE_DISCONNECTED:'NODE_FROM_NODE_DISCONNECTED',
      NODE_FROM_PARAM_DISCONNECTED:'NODE_FROM_PARAM_DISCONNECTED',
      AUDIO_NODE_HIGHLIGHTED:'AUDIO_NODE_HIGHLIGHTED',
      AUDIO_NODE_UNHIGHLIGHTED:'AUDIO_NODE_UNHIGHLIGHTED'
    }
  }
};

/**
 * The data type for the ID unique to each resource.
 * @typedef {number}
 * @private
 */
audion.entryPoints.Id_;


/**
 * Stores data on an AudioContext.
 * @typedef{{
 *   id: audion.entryPoints.Id_,
 * }}
 * @private
 */
audion.entryPoints.AudioContextData_;


/**
 * Stores data on an AudioNode ... as well as the AudioNode. We may later plan
 * to remove the reference to the audio node for AudioBufferSourceNodes so that
 * the buffers they refer to can be garbage-collected. That is why that field is
 * nullable.
 * @typedef{{
 *   id: audion.entryPoints.Id_,
 *   node: ?AudioNode
 * }}
 * @private
 */
audion.entryPoints.AudioNodeData_;


/**
 * Stores data on an AudioParam. This stores no reference to the AudioParam:
 * The param can be readily accessed via the AudioNode.
 * @typedef{{
 *   id: audion.entryPoints.Id_,
 *   audioNodeId: audion.entryPoints.Id_,
 *   propertyName: string
 * }}
 * @private
 */
audion.entryPoints.AudioParamData_;


/**
 * The name of a property (assigned to resources) for the resource ID.
 * @private @const {string}
 */
audion.entryPoints.resourceIdField_ = '__resource_id__';


/**
 * If we need a new ID for anything, we just increment this value. Every
 * BaseAudioContext, AudioNode, and AudioParam gets a unique ID.
 * @type {number}
 */
audion.entryPoints.nextAvailableId_ = 1;


/**
 * The keys of this object comprise a set of IDs of AudioNodes that the user is
 * interested in inspecting. We will periodically send back property-value data
 * on each AudioNode in this set until the node becomes unhighlighted. The
 * values of this object are all 1.
 * @private {!Object.<audion.entryPoints.Id_, number>}
 */
audion.entryPoints.highlightedAudioNodeIds_ = {};


/**
 * The requestAnimationFrameId for the rendering cycles used to report data on
 * the properties of a node back to the dev tools script. This value is used to
 * later cancel sending back the data. This value is null if no rAF is pending.
 * @private {?number}
 */
audion.entryPoints.reportDataAnimationFrameId_ = null;


/**
 * Maps IDs to data objects (see type defs above). Each resource (
 * AudioContext, AudioNode, and AudioParam) has its own ID.
 * @private {!Object.<audion.entryPoints.Id_, !Object>}
 */
audion.entryPoints.idToResource_ = {};


/**
 * @return {string} The target that postMessage should use to issue messages to
 *     this page.
 * @private
 */
audion.entryPoints.determinePostMessageTarget_ = function() {
   var origin = window.location.origin
   if (origin && origin.indexOf('file:') != 0) {
     // We try to use as specific an origin as possible. But also, as of this
     // writing, posting a message to a page at a file: URL requires that the
     // target origin argument be '*', so we accommodate that.
     return origin;
   }
   return '*';
};


/**
 * The target that postMessage uses to issue messages to this page. Those
 * messages could be picked up by the tracing code injected into the page via
 * the content script.
 * @private @const {string}
 */
audion.entryPoints.postMessageTarget_ =
    audion.entryPoints.determinePostMessageTarget_();


/**
 * Posts a message to the content script. Adds a tag to the message to
 * indicate that the message comes from this extension.
 * @param {!AudionMessage} messageToSend
 * @private
 */
audion.entryPoints.postToContentScript_ = function(messageToSend) {
  // messageToSend.tag = audion.entryPoints.ExtensionTag.FromTracing;
  messageToSend.tag = 'AudioPipesToBackground';
  // Post the message to this window only. The content script will pick it up.
  window.postMessage(messageToSend, audion.entryPoints.postMessageTarget_);
}


/**
 * Assigns a read-only ID property to an object.
 * @param {!Object} resource
 * @param {audion.entryPoints.Id_} id
 * @private
 */
audion.entryPoints.assignIdProperty_ = function(resource, id) {
  Object.defineProperty(resource, audion.entryPoints.resourceIdField_, {
    value: id,
    writable: false
  });
};


/**
 * Determines the channel to use in the graph visualization based on a user
 * argument for either input or output channel. This function is necessary
 * because the values passed into those arguments are sometimes not numbers, and
 * in those cases, the Web Audio API behaves gracefully (defaults to 0), but the
 * extension throws an exception.
 * @param {*} channelValue Whatever the caller passed as the channel. This could
 *     be anything. Ideally, it's either a number or undefined.
 * @private
 */
audion.entryPoints.determineChannelValue_ = function(channelValue) {
  // Try converting value into a number if it is not one already. If it is a
  // string, this will convert as expected, ie "42" to 42. Otherwise, we default
  // to 0 as the Web Audio API does. For instance, unexpected objects passed as
  // a channel argument get converted to 0.
  return Number(channelValue) || 0;
};


/**
 * Instruments a newly created node and its AudioParams.
 * @param {!AudioNode} node
 * @private
 */
audion.entryPoints.instrumentNode_ = function(node) {
  var nodeId = audion.entryPoints.nextAvailableId_++;
  audion.entryPoints.assignIdProperty_(node, nodeId);
  audion.entryPoints.idToResource_[nodeId] =
      /** @type {!audion.entryPoints.AudioNodeData_} */ ({
    id: nodeId,
    node: node
  });
  console.log('instrumentNode_', nodeId, node);
  // Instrument AudioParams.
  // var audioParamNames = [];
  // for (var prop in node) {
  //   var audioParam = node[prop];
  //   if (audioParam instanceof AudioParam) {
  //     // Store the ID of the node the param belongs to. And the param name.
  //     var audioParamId = audion.entryPoints.nextAvailableId_++;
  //     audion.entryPoints.assignIdProperty_(audioParam, audioParamId);
  //     audion.entryPoints.idToResource_[audioParamId] =
  //         /** @type {!audion.entryPoints.AudioParamData_} */ ({
  //           id: audioParamId,
  //           audioNodeId: nodeId,
  //           propertyName: prop
  //         });
  //     audioParamNames.push(prop);
  //   }
  // }

  // Notify extension about the addition of a new node.
  // audion.entryPoints.postToContentScript_(
  //     /** @type {!AudionNodeCreatedMessage} */ ({
  //   type: audion.messaging.MessageType.NODE_CREATED,
  //   nodeId: nodeId,
  //   nodeType: node.constructor.name,
  //   numberOfInputs: node.numberOfInputs,
  //   numberOfOutputs: node.numberOfOutputs,
  //   audioParamNames: audioParamNames,
  //   isOffline: node.context instanceof OfflineAudioContext
  //   // TODO(chizeng): Include a stack trace for the creation of the node.
  // }));
};


/**
 * Creates either an AudioContext or OfflineAudioContext.
 * @param {!Function} nativeConstructor
 * @param {!Array.<*>} argumentsList A list of argument params.
 * @param {boolean} isOffline Whether this context is an offline one.
 * @return {!BaseAudioContext} The constructed subclass.
 * @private
 */
audion.entryPoints.createBaseAudioContextSubclass_ = function(
    nativeConstructor, argumentsList, isOffline) {
  // Null is the context. We cannot append to Arguments because it's not a
  // list. We convert it to a list by slicing.
  var newContext = /** @type {!BaseAudioContext} */ (
      new (Function.prototype.bind.apply(
          nativeConstructor, [null].concat(argumentsList))));
  var audioContextId = audion.entryPoints.nextAvailableId_++;
  audion.entryPoints.assignIdProperty_(newContext, audioContextId);
  audion.entryPoints.idToResource_[audioContextId] =
      /** @type {!audion.entryPoints.AudioContextData_} */ ({
        id: audioContextId
      });

  // Tell the extension that we have created a new AudioContext.
  // audion.entryPoints.postToContentScript_(
  //     /** @type {!AudionContextCreatedMessage} */ ({
  //       type: audion.messaging.MessageType.CONTEXT_CREATED,
  //       contextId: audioContextId
  //     }));

  // Instrument the destination node.
  // audion.entryPoints.instrumentNode_(newContext.destination);
  return newContext;
};


/**
 * The entry point for tracing (ie detecting) web audio API calls. Suppress
 * type-checking for this function - it does crazy stuff with prototype
 * overrides that makes the compiler go AHHH!. Keep all logic within the scope
 * of this function - this is called as a closure.
 *
 * This JS runs once in every window or frame.
 *
 * @suppress {checkTypes}
 */
audion.entryPoints.tracing = function() {

  // var audioDestination;
  // var peerDestination;

  if (!AudioPipes.WebAudio) {
    AudioPipes.WebAudio = {};
  }

  AudioPipes.WebAudio.getPeerDestination = function() {
    return AudioPipes.WebAudio.peerDestination;
  }

  AudioPipes.WebAudio.disablePeerDestination = function() {
    AudioPipes.WebAudio.peerDestination = false;
  }

  /**
   * Logs a message to the console for debugging.
   * @param {string} message
   */
  function logMessage(message) {
    window.console.log(message);
  }


  /**
   * Wraps a native function with a decorator function. That decorator function
   * takes a reference to the original native function and a list of arguments
   * used to call it.
   * @param {function(...*):*} originalNativeFunction A reference to the
   *     original native function we are overriding.
   * @param {function(function(...*):*, !Array.<*>):*} decorator The function
   *     that takes the original native function as the first argument and a
   *     a list of original arguments.
   * @return {function(...*):*} The wrapped / decorated function.
   */
  function wrapNativeFunction(originalNativeFunction, decorator) {
    return function() {
      return decorator.call(this, originalNativeFunction, arguments);
    };
  }

  // Keep a reference to the native AudioContext constructor. We later override
  //
  var nativeAudioContextConstructor = AudioContext;

  // We now trace connect and disconnects.

  /**
   * Wraps the web audio connect method.
   * @param {function(...*):*} nativeConnect The native connect method.
   * @param {!Array.<*>} originalArguments The original arguments connect was
   *     called with.
   * @return {*} Whatever the connect method returns.
   * @this {!AudioNode}
   */
  function connectDecorator(nativeConnect, originalArguments) {
    var result = nativeConnect.apply(this, originalArguments);

    // TODO: Figure out what happens if we connect with something falsy (or
    // nothing at all). Do we disconnect?
    if (originalArguments.length == 0 || !originalArguments[0]) {
      return result;
    }

    var otherThing = originalArguments[0];
    var otherThingId = otherThing[audion.entryPoints.resourceIdField_];

    // If no input / output is specified, default to 0.
    var fromChannel = audion.entryPoints.determineChannelValue_(
        originalArguments[1]);
    var toChannel = audion.entryPoints.determineChannelValue_(
        originalArguments[2]);

    if (AudioPipes.WebAudio.peerDestination && (otherThing == AudioPipes.WebAudio.audioDestination)) {
      // connect it to the remote as well
      console.log('connecting to remote', this);
      var newArgs = Array.prototype.slice.call(originalArguments, 1);
      newArgs.unshift(AudioPipes.WebAudio.peerDestination);
      nativeConnect.apply(this, newArgs);
    }

    // if (otherThingId) {
      // // Warn if we cannot identify what we are connecting from.
      // var sourceResourceId = this[audion.entryPoints.resourceIdField_];
      // if (!sourceResourceId) {
      //   console.warn(
      //       'Audion could not identify the object calling "connect": ', this);
      // }

      // // Notify the extension of a connection with either an AudioNode or an
      // // AudioParam.
      // if (otherThing instanceof AudioNode) {
      //   audion.entryPoints.postToContentScript_(
      //       /** type {!AudionNodeToNodeConnectedMessage} */ ({
      //         type: audion.messaging.MessageType.NODE_TO_NODE_CONNECTED,
      //         sourceNodeId: sourceResourceId,
      //         destinationNodeId: otherThingId,
      //         fromChannel: fromChannel,
      //         toChannel: toChannel
      //       }));
      // } else if (otherThing instanceof AudioParam) {
      //   var audioParamData =
      //       /** @type {!audion.entryPoints.AudioParamData_} */ (
      //           audion.entryPoints.idToResource_[otherThingId]);
      //   audion.entryPoints.postToContentScript_(
      //       /** type {!AudionNodeToParamConnectedMessage} */ ({
      //         type: audion.messaging.MessageType.NODE_TO_PARAM_CONNECTED,
      //         sourceNodeId: sourceResourceId,
      //         destinationNodeId: audioParamData.audioNodeId,
      //         destinationParamName: audioParamData.propertyName,
      //         fromChannel: fromChannel
      //       }));
      // }
    // }
    return result;
  }
  /** @override */
  AudioNode.prototype.connect = wrapNativeFunction(
      AudioNode.prototype.connect, connectDecorator);


  /**
   * Wraps the web audio disconnect method.
   * @param {function(...*):*} nativeDisconnect The native disconnect method.
   * @param {!Array.<*>} originalArguments The original arguments disconnect was
   *     called with.
   * @return {*} Whatever the disconnect method returns.
   * @this {!AudioNode}
   */
  function disconnectDecorator(nativeDisconnect, originalArguments) {
    var result = nativeDisconnect.apply(this, originalArguments);

    if (originalArguments.length == 0 || !originalArguments[0]) {
      // All edges emanating from this node gad been removed.
      // audion.entryPoints.postToContentScript_(
      //     /** @type {!AudionAllDisconnectedMessage} */ ({
      //       type: audion.messaging.MessageType.ALL_DISCONNECTED,
      //       nodeId: this[audion.entryPoints.resourceIdField_]
      //     }));

      // JanM: ToDo do we have to figure out whether this node was connected to our remote? Or is it disconnected automatically?
      return result;
    }

    var otherThing = originalArguments[0];

    // Default to input / output 0.
    var fromChannel = audion.entryPoints.determineChannelValue_(
        originalArguments[1]);
    var toChannel = audion.entryPoints.determineChannelValue_(
        originalArguments[2]);

    if (AudioPipes.WebAudio.peerDestination && (otherThing == AudioPipes.WebAudio.audioDestination)) {
      // disconnect it from the remote as well
      var newArgs = Array.prototype.slice.call(originalArguments, 1);
      newArgs.unshift(AudioPipes.WebAudio.peerDestination);
      nativeDisconnect.apply(this, newArgs);
    }


    // var otherThingId = otherThing[audion.entryPoints.resourceIdField_];
    // if (otherThingId) {
    //   // We disconnect from a specific AudioNode or an AudioParam.
    //   if (otherThing instanceof AudioNode) {
    //     audion.entryPoints.postToContentScript_(
    //         /** @type {!AudionNodeFromNodeDisconnectedMessage} */ ({
    //           type: audion.messaging.MessageType.NODE_FROM_NODE_DISCONNECTED,
    //           sourceNodeId: this[audion.entryPoints.resourceIdField_],
    //           disconnectedFromNodeId: otherThingId,
    //           fromChannel: fromChannel,
    //           toChannel: toChannel
    //         }));
    //   } else if (otherThing instanceof AudioParam) {
    //     var audioParamData =
    //         /** @type {!audion.entryPoints.AudioParamData_} */ (
    //             audion.entryPoints.idToResource_[otherThingId]);
    //     audion.entryPoints.postToContentScript_(
    //         /** @type {!AudionNodeFromParamDisconnectedMessage} */ ({
    //           type: audion.messaging.MessageType.NODE_FROM_PARAM_DISCONNECTED,
    //           sourceNodeId: this[audion.entryPoints.resourceIdField_],
    //           disconnectedFromNodeId: audioParamData.audioNodeId,
    //           audioParamName: audioParamData.propertyName,
    //           fromChannel: fromChannel
    //         }));
    //   }
    // }
    return result;
  }
  /** @override */
  // AudioNode.prototype.disconnect = wrapNativeFunction(
  //     AudioNode.prototype.disconnect, disconnectDecorator);


  // Instrument the native AudioContext constructor. Patch the prototype chain.
  AudioContext = function() {
    // We must pass a list (not an Arguments object), so we use the slice method
    // on the Array constructor's prototype to quickly convert to a list.
    var ctx = audion.entryPoints.createBaseAudioContextSubclass_(
        nativeAudioContextConstructor,
        Array.prototype.slice.call(arguments), false);
    AudioPipes.WebAudio.audioDestination = ctx.destination;
    AudioPipes.WebAudio.peerDestination = ctx.createMediaStreamDestination();
    audion.entryPoints.postToContentScript_({
      type: 'audio_available'
    });
    return ctx;
  };
  AudioContext.prototype = nativeAudioContextConstructor.prototype;
  AudioContext.prototype.constructor = AudioContext;

  // Do the same for OfflineAudioContext.
  var nativeOfflineAudioContextConstructor = OfflineAudioContext;
  OfflineAudioContext = function() {
    // We must pass a list (not an Arguments object), so we use the slice method
    // on the Array constructor's prototype to quickly convert to a list.
    return audion.entryPoints.createBaseAudioContextSubclass_(
        nativeOfflineAudioContextConstructor,
        Array.prototype.slice.call(arguments), true);
  };
  OfflineAudioContext.prototype =
      nativeOfflineAudioContextConstructor.prototype;
  OfflineAudioContext.prototype.constructor = OfflineAudioContext;

  // Listen to messages on the window that are related to the extension.
  // Listen to messages from the page. Relay them to the background script.
  window.addEventListener('message', function(event) {
    if (event.source != window) {
      // We are not interested in messages from other windows.
      return;
    }

    var message = /** @type {?AudionTaggedMessage} */ (event.data);
    if (!message ||
         message.tag != audion.entryPoints.ExtensionTag.ToTracing) {
      // This message is not relevant to this extension.
      return;
    }
  });

  /**
   * A global method for the user (developer) to be able to fetch AudioNodes
   * from the console. The user gleans the ID from the graph visualization.
   * @param {number} audioNodeId The ID of the AudioNode assigned by this tool.
   * @return {?AudioNode} The AudioNode if there is one with the ID.
   */
  window['__node__'] = function(audioNodeId) {
    var resource = audion.entryPoints.idToResource_[audioNodeId];
    if (!resource) {
      // No such node with this ID.
      return null;
    }
    resource = /** @type {!audion.entryPoints.AudioNodeData_} */ (resource);
    if (!(resource.node instanceof AudioNode)) {
      // This is not an AudioNode. It could be an AudioContext. Or a param.
      return null;
    }
    return resource.node;
  };

  // logMessage('tracing done');
};


audion.entryPoints.tracing();
