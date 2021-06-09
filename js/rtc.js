var AudioPipes = window.AudioPipes || {};

(function () {
  "use strict";

  let nativeAudioContextConstructor = AudioContext;
  // let nativeNavigatorGetUserMedia = navigator.getUserMedia;
  // let nativeDevicesGetUserMedia = navigator.mediaDevices.getUserMedia;

  var userMediaStreams = [];

  if (!AudioPipes.RTC) {
    AudioPipes.RTC = {};
  }
  if (!AudioPipes.WebAudio) {
    AudioPipes.WebAudio = {};
  }

  AudioNode.prototype.connect = wrapNativeFunction(
    AudioNode.prototype.connect,
    connectDecorator
  );
  AudioNode.prototype.disconnect = wrapNativeFunction(
    AudioNode.prototype.disconnect,
    disconnectDecorator
  );
  AudioPipes.sendMessage = sendMessage;
  AudioPipes.RTC.init = initializeRTC;
  AudioPipes.RTC.addStream = addStream;
  AudioPipes.RTC.makeOffer = makeOffer;
  //AudioPipes.RTC.setupMaster = setupMaster;

  // override AudioContext constructor
  AudioContext = function () {
    var ctx = createBaseAudioContextSubclass(
      nativeAudioContextConstructor,
      Array.prototype.slice.call(arguments),
      false
    );
    AudioPipes.WebAudio.audioDestination = ctx.destination;
    AudioPipes.WebAudio.mutableAudioDestination = ctx.createGain();
    AudioPipes.WebAudio.mutableAudioDestination.connect(ctx.destination);
    AudioPipes.WebAudio.peerDestination = ctx.createMediaStreamDestination();
    AudioPipes.WebAudio.audioContext = ctx;
    sendMessage({
      type: "audio_source_available",
      title: document.title,
    });
    return ctx;
  };
  AudioContext.prototype = nativeAudioContextConstructor.prototype;
  AudioContext.prototype.constructor = AudioContext;

  // override getUserMedia
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia = wrapNativeFunction(
      navigator.mediaDevices.getUserMedia,
      function (nativeGetUserMedia, args) {
        return nativeGetUserMedia.apply(this, args).then(function (stream) {
          // return prepareUserMediaStream(stream);
          // keep track of the usermediastream
          if (!userMediaStreams.includes(stream)) {
            userMediaStreams.push(stream);
          }
          return stream;
        });
        // error falls through
      }
    );
  }
  if (navigator.getUserMedia) {
    navigator.getUserMedia = wrapNativeFunction(
      navigator.getUserMedia,
      function (nativeGetUserMedia, args) {
        var args_ = Array.prototype.slice.call(args);
        // let _cb = function(stream) {
        // 	args_[1](prepareUserMediaStream(stream));
        // }
        navigator.mediaDevices
          .getUserMedia(args_[0])
          .then(function (stream) {
            // already decorated
            args_[1](stream);
          })
          .catch(function (err) {
            args_[2](err);
          });
        // nativeGetUserMedia.apply(this, [args_[0], _cb, args_[2]]);
      }
    );
  }

  // override createMediaStreamSource to return an AudioNode instead
  AudioContext.prototype.createMediaStreamSource = wrapNativeFunction(
    AudioContext.prototype.createMediaStreamSource,
    function (nativeCreate, originalArguments) {
      console.log(
        "createMediaStreamSource",
        originalArguments[0],
        userMediaStreams
      );
      if (!userMediaStreams.includes(originalArguments[0])) {
        // other kind of mediastream
        return nativeCreate.apply(this, originalArguments);
      } else {
        let userStreamNode = nativeCreate.apply(this, originalArguments);
        if (!AudioPipes.WebAudio.peerSourceMixerNode) {
          // peer sources will be mixed in here
          AudioPipes.WebAudio.peerSourceMixerNode =
            AudioPipes.WebAudio.audioContext.createGain();
          AudioPipes.WebAudio.peerSourceMixerNode.gain.value = 0.5;
        }
        if (!AudioPipes.WebAudio.userMediaGainNode) {
          AudioPipes.WebAudio.userMediaGainNode =
            AudioPipes.WebAudio.audioContext.createGain();
          AudioPipes.WebAudio.userMediaGainNode.gain.value = 0.5;
        }
        userStreamNode.connect(AudioPipes.WebAudio.userMediaGainNode);
        AudioPipes.WebAudio.userMediaGainNode.connect(
          AudioPipes.WebAudio.peerSourceMixerNode
        );

        // put the streamNode in the AudioPipes and signal remote destination
        // return nativeCreate.apply(this, originalArguments);
        sendMessage({
          type: "audio_destination_available",
          title: document.title,
        });
        return AudioPipes.WebAudio.peerSourceMixerNode;
      }
    }
  );

  // ToDo do the above for the MediaStreamAudioSourceNode constructor as well

  var postMessageTarget = (function () {
    var origin = window.location.origin;
    if (origin && origin.indexOf("file:") != 0) {
      // We try to use as specific an origin as possible. But also, as of this
      // writing, posting a message to a page at a file: URL requires that the
      // target origin argument be '*', so we accommodate that.
      return origin;
    }
    return "*";
  })();

  window.addEventListener("message", function (event) {
    // console.log('msg event', event);
    if (event.source != window) {
      // We are not interested in messages from other windows.
      return;
    }
    var message = event.data;
    if (!message || message.tag != "AudioPipesToPage") {
      // This message is not relevant to this extension.
      return;
    }
    receiveMessage(message);
  });

  function sendMessage(msg) {
    // tag it
    msg.tag = "AudioPipesToBackground";
    window.postMessage(msg, postMessageTarget);
  }

  function receiveMessage(msg) {
    // console.log('receiveMessage', msg);
    switch (msg.type) {
      case "rtc_init":
        initializeRTC(true);
        break;
      case "rtc_candidate":
        addCandidate(msg.candidate);
        break;
      case "rtc_offer":
        answer(msg);
        break;
      case "rtc_answer":
        connect(msg.answer);
        break;
      case "audio_prepare_receive":
        setupMaster();
        break;
      case "reset":
        reset();
        break;
      case "record_control":
        recordControl(msg);
        break;
    }
  }

  function initializeRTC(_makeOffer) {
    if (AudioPipes.RTC.peerConnection) {
      console.warn("already initialized");
    }
    var pc = new RTCPeerConnection(null); // no servers, we signal via the extension
    pc.onicecandidate = function (evt) {
      // local candidate, send it to the extenstion
      console.log("onicecandidate", evt);
      if (evt.candidate) {
        sendMessage({
          type: "rtc_candidate",
          candidate: {
            candidate: evt.candidate.candidate,
            sdpMLineIndex: evt.candidate.sdpMLineIndex,
            sdpMid: evt.candidate.sdpMid,
          },
        });
      }
    };
    AudioPipes.RTC.peerConnection = pc;
    if (_makeOffer) {
      if (AudioPipes.WebAudio && AudioPipes.WebAudio.peerDestination) {
        var dest = AudioPipes.WebAudio.peerDestination;
        if (dest && dest.stream) {
          addStream(dest.stream);
        }
      }
      makeOffer();
    }
  }

  function addRemoteStream(evt) {
    console.log("addRemoteStream", evt);
    // mute the userMedia
    AudioPipes.WebAudio.userMediaGainNode.gain.value = 0;

    if (!AudioPipes.WebAudio.remoteAudioElement) {
      AudioPipes.WebAudio.remoteAudioElement = document.createElement("audio");
      document.body.appendChild(AudioPipes.WebAudio.remoteAudioElement);
    } else {
    }
    // only one stream target ?
    AudioPipes.WebAudio.remoteAudioElement.srcObject = evt.stream;
    if (document.getElementById("remoteAudio")) {
      // document.getElementById('remoteAudio').srcObject = evt.stream;
      // return;
    }
    // if (document.getElementById('remoteVideo')) {
    // 	document.getElementById('remoteVideo').srcObject = evt.stream;
    // 	return;
    // }
    // create an audionode from the stream
    var remoteStreamNode =
      AudioPipes.WebAudio.audioContext.createMediaStreamSource(evt.stream);
    // mix it in with the getUserMedia streamNode
    remoteStreamNode.connect(AudioPipes.WebAudio.peerSourceMixerNode);

    // var oscillator = AudioPipes.WebAudio.audioContext.createOscillator();
    // oscillator.type = 'square';
    // oscillator.frequency.value = 440; // value in hertz
    // oscillator.connect(AudioPipes.WebAudio.peerSourceMixerNode);
    // oscillator.start();

    // ToDo: add some metadata and keep reference to the remoteNode
    if (!AudioPipes.WebAudio.remoteStreamNodes) {
      AudioPipes.WebAudio.remoteStreamNodes = [];
    }
    AudioPipes.WebAudio.remoteStreamNodes.push(remoteStreamNode);
  }

  function addStream(stream) {
    AudioPipes.RTC.peerConnection.addStream(stream);
    // stream.getTracks().forEach(function(track) {
    // 	AudioPipes.RTC.peerConnection.addTrack(track, stream);
    // });
  }

  function addCandidate(candidate) {
    AudioPipes.RTC.peerConnection.addIceCandidate(candidate);
  }

  function answer(msg) {
    AudioPipes.RTC.peerConnection.ondatachannel = function (evt) {
      attachDataChannel(evt.channel);
    };
    AudioPipes.RTC.peerConnection
      .setRemoteDescription(new RTCSessionDescription(msg.offer))
      .then(function () {
        return AudioPipes.RTC.peerConnection.createAnswer();
      })
      .then(function (sessionDescription) {
        console.log("answer", sessionDescription.sdp);
        return AudioPipes.RTC.peerConnection.setLocalDescription(
          sessionDescription
        );
      })
      .then(function () {
        sendMessage({
          type: "rtc_answer",
          portId: msg.portId,
          answer: {
            sdp: AudioPipes.RTC.peerConnection.localDescription.sdp,
            type: AudioPipes.RTC.peerConnection.localDescription.type,
          },
        });
      });
  }

  function connect(answer) {
    AudioPipes.RTC.peerConnection
      .setRemoteDescription(new RTCSessionDescription(answer))
      .then(function () {
        console.log("setRemoteDescription done", answer);
      })
      .catch(function (err) {
        console.error("setRemoteDescription error", err);
      });
  }

  function makeOffer() {
    console.log("making offer");
    // first add dataChannel, so it will be in the offer and candidates
    attachDataChannel(
      AudioPipes.RTC.peerConnection.createDataChannel("record_control", {
        ordered: false, // just do it fast, it will be reliable
      })
    );
    AudioPipes.RTC.peerConnection
      .createOffer({ voiceActivityDetection: false, offerToReceiveAudio: true })
      .then(function (offer) {
        console.log("offer", offer.sdp);
        return AudioPipes.RTC.peerConnection.setLocalDescription(offer);
      })
      .then(function () {
        // send the offer and mute the local destination
        AudioPipes.WebAudio.mutableAudioDestination.gain.value = 1.0;
        sendMessage({
          type: "rtc_offer",
          offer: {
            sdp: AudioPipes.RTC.peerConnection.localDescription.sdp,
            type: AudioPipes.RTC.peerConnection.localDescription.type,
          },
        });
        addRecordButton();
      })
      .catch(function (err) {
        console.error("makeOffer", err);
      });
  }

  function attachDataChannel(channel) {
    AudioPipes.RTC.dataChannel = channel;
    channel.onmessage = function (msgEvt) {
      receiveMessage({
        type: msgEvt.currentTarget.label,
        data: msgEvt.data,
      });
    };
    window.emitRecordState = function (isRecording) {
      if (isRecording) {
        AudioPipes.RTC.dataChannel.send("record_started");
      } else {
        AudioPipes.RTC.dataChannel.send("record_stopped");
      }
    };
  }

  function setupMaster(streamCallback) {
    if (AudioPipes.WebAudio) {
      // AudioPipes.WebAudio.disablePeerDestination();
    }
    initializeRTC();
    // AudioPipes.RTC.peerConnection.ontrack = addRemoteStream;
    // AudioPipes.RTC.peerConnection.onaddstream = streamCallback;
    AudioPipes.RTC.peerConnection.onaddstream = addRemoteStream;
    // sendMessage({ type: 'request_offers' });
  }

  // function prepareUserMediaStream(stream) {
  // 	// ToDo should we check if userStream already exists?
  // 	AudioPipes.WebAudio.userMediaStream = stream;
  // 	AudioPipes.WebAudio.sourceMixerStream = new MediaStream(); // we'll add in remote streams later, hopefully
  // 	let tracks = stream.getTracks();
  // 	for (var i = tracks.length - 1; i >= 0; i--) {
  // 		// tracks[i].muted = true;
  // 		tracks[i].applyConstraints({ volume: 0.0 });
  // 		AudioPipes.WebAudio.sourceMixerStream.addTrack(tracks[i]);
  // 	}
  // 	// if (!AudioPipes.WebAudio.peerSourceMixerNode) {
  // 	// 	AudioPipes.WebAudio.peerSourceMixerNode = AudioPipes.WebAudio.audioContext.createGain();
  // 	// }
  // 	// if (!AudioPipes.WebAudio.userMediaGainNode) {
  // 	// 	AudioPipes.WebAudio.userMediaGainNode = AudioPipes.WebAudio.audioContext.createGain();
  // 	// }
  // 	// stream.connect(AudioPipes.WebAudio.userMediaGainNode);
  // 	// AudioPipes.WebAudio.userMediaGainNode.connect(AudioPipes.WebAudio.peerSourceMixerNode);
  // 	// post message to extension
  // 	sendMessage({ type: 'audio_destination_available' });
  // 	return AudioPipes.WebAudio.sourceMixerStream;
  // }

  function createBaseAudioContextSubclass(
    nativeConstructor,
    argumentsList,
    isOffline
  ) {
    // Null is the context. We cannot append to Arguments because it's not a
    // list. We convert it to a list by slicing.
    var newContext = new (Function.prototype.bind.apply(
      nativeConstructor,
      [null].concat(argumentsList)
    ))();
    return newContext;
  }

  function connectDecorator(nativeConnect, originalArguments) {
    // TODO: Figure out what happens if we connect with something falsy (or
    // nothing at all). Do we disconnect?
    if (originalArguments.length == 0 || !originalArguments[0]) {
      return undefined;
    }

    var otherThing = originalArguments[0];
    // are we connecting to destination ?
    if (
      AudioPipes.WebAudio.peerDestination &&
      otherThing == AudioPipes.WebAudio.audioDestination
    ) {
      console.log("connecting to remote", this);
      // nativeConnect.apply(this, originalArguments);
      // Connecting to peer Destination
      var newArgs = Array.prototype.slice.call(originalArguments, 1);
      newArgs.unshift(AudioPipes.WebAudio.peerDestination);
      nativeConnect.apply(this, newArgs);
      // and connect it to the mutable audio destions
      newArgs = Array.prototype.slice.call(originalArguments, 1);
      newArgs.unshift(AudioPipes.WebAudio.mutableAudioDestination);
      nativeConnect.apply(this, newArgs);
      return AudioPipes.WebAudio.audioDestination;
    } else {
      return nativeConnect.apply(this, originalArguments);
    }
  }

  function disconnectDecorator(nativeDisconnect, originalArguments) {
    var result = nativeDisconnect.apply(this, originalArguments);

    if (originalArguments.length == 0 || !originalArguments[0]) {
      // JanM: ToDo do we have to figure out whether this node was connected to our remote? Or is it disconnected automatically?
      return result;
    }

    var otherThing = originalArguments[0];
    if (
      AudioPipes.WebAudio.peerDestination &&
      otherThing == AudioPipes.WebAudio.audioDestination
    ) {
      // disconnect it from the remote as well
      var newArgs = Array.prototype.slice.call(originalArguments, 1);
      newArgs.unshift(AudioPipes.WebAudio.peerDestination);
      nativeDisconnect.apply(this, newArgs);
    }
    return result;
  }

  function wrapNativeFunction(originalNativeFunction, decorator) {
    return function () {
      return decorator.call(this, originalNativeFunction, arguments);
    };
  }

  // Do the same for OfflineAudioContext.
  /*
	var nativeOfflineAudioContextConstructor = OfflineAudioContext;
	OfflineAudioContext = function() {
		return audion.entryPoints.createBaseAudioContextSubclass_(
		    nativeOfflineAudioContextConstructor,
		    Array.prototype.slice.call(arguments), true);
	};
	OfflineAudioContext.prototype = nativeOfflineAudioContextConstructor.prototype;
	OfflineAudioContext.prototype.constructor = OfflineAudioContext;
	*/

  function reset() {
    console.warn("Resetting");
    removeRecordButton();
    // disconnect peer audioNodes
    if (AudioPipes.WebAudio.remoteStreamNodes) {
      AudioPipes.WebAudio.remoteStreamNodes.forEach(function (node) {
        node.disconnect();
      });
      AudioPipes.WebAudio.remoteStreamNodes = [];
    }
    if (AudioPipes.RTC.peerConnection) {
      AudioPipes.RTC.peerConnection.close();
    }
    // clean up peerconnection
    AudioPipes.RTC.peerConnection = null; // will be initialized later on

    if (AudioPipes.WebAudio.userMediaGainNode) {
      // restore volume from userMedia
      AudioPipes.WebAudio.userMediaGainNode.gain.value = 1.0;
    }
    if (AudioPipes.WebAudio.mutableAudioDestination) {
      AudioPipes.WebAudio.mutableAudioDestination.gain.value = 1.0;
    }
  }

  function addRecordButton() {
    if (AudioPipes.WebAudio.recordButton) {
      removeRecordButton();
    }
    AudioPipes.WebAudio.recordButton = document.createElement("div");
    AudioPipes.WebAudio.recordButton.style.position = "fixed";
    AudioPipes.WebAudio.recordButton.style.top = "10px";
    AudioPipes.WebAudio.recordButton.style.right = "10px";
    AudioPipes.WebAudio.recordButton.style.width = "40px";
    AudioPipes.WebAudio.recordButton.style.height = "40px";
    AudioPipes.WebAudio.recordButton.style.backgroundColor = "red";
    AudioPipes.WebAudio.recordButton.style.borderRadius = "24px";
    AudioPipes.WebAudio.recordButton.style.borderWidth = "4px";
    AudioPipes.WebAudio.recordButton.style.borderColor =
      "rgba(255,255,255,0.4)";
    AudioPipes.WebAudio.recordButton.style.borderStyle = "solid";
    AudioPipes.WebAudio.recordButton.style.cursor = "pointer";
    AudioPipes.WebAudio.recordButton.style.transition = "all .1s linear";
    AudioPipes.WebAudio.recordButton.style.zIndex = 1000000000;
    AudioPipes.WebAudio.recordButton.onclick = function (evt) {
      // stop click propagation ?
      try {
        console.log("sending record message", new Date().getTime());
        AudioPipes.RTC.dataChannel.send("record");
      } catch (ex) {
        console.error(ex);
      }
    };
    document.body.appendChild(AudioPipes.WebAudio.recordButton);
  }

  function removeRecordButton() {
    if (AudioPipes.WebAudio.recordButton) {
      document.body.removeChild(AudioPipes.WebAudio.recordButton);
      AudioPipes.WebAudio.recordButton = false;
    }
  }

  function setRecordButtonState(state) {
    if (!AudioPipes.WebAudio.recordButton) {
      return;
    }
    if (state == "record_started") {
      AudioPipes.WebAudio.recordButton.style.borderRadius = "2px";
    } else {
      AudioPipes.WebAudio.recordButton.style.borderRadius = "24px";
    }
  }

  function recordControl(msg) {
    switch (msg.data) {
      case "record":
        console.log("got record message", new Date().getTime());
        // emit Record event
        window.onrecord && window.onrecord(msg);
        break;
      case "record_started":
      case "record_stopped":
        setRecordButtonState(msg.data);
        break;
    }
  }
})();

// AudioPipes.sendMessage({type: 'test', msg:'test from rtc.js'});

// AudioPipes.RTC.init();
// AudioPipes.RTC.
