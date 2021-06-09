chrome.runtime.onConnect.addListener(function (port) {
  // Each connection to the background script has a unique port name
  // designating its general purpose.
  var portName = port.name;

  switch (portName) {
    case "init_frame":
      // A new frame has initialized in some tab.
      handleNewFrameConnection_(port);
      break;
    case "popup":
      handleNewPopupConnection(port);
      break;
    default:
      console.warn("unhandled connect port", port);
  }
});

var nodes = new Map();
// var currentDestination = undefined;
var mixer = {
  destination: { id: undefined, port: undefined },
  sources: new Map(),
};

const activePopups = new Map();
handleNewPopupConnection = function (port) {
  port.onMessage.addListener(receivePopupMessage);
  port.onDisconnect.addListener(() => {
    activePopups.delete(port.id);
  });
  activePopups.set(port.id, port);
  sendNodesToPopup(port);
};

const sendNodesToPopup = function (port) {
  // send it all possible sources
  var sourceTitles = [];
  var destinationTitles = [];
  for (let p of nodes) {
    let node = p[1];
    if (node.isSource) {
      sourceTitles.push({
        id: node.id,
        title: node.title,
        active: node.sourceActive,
      });
    }
    if (node.isDestination) {
      destinationTitles.push({
        id: node.id,
        title: node.title,
        active: node.destinationActive,
      });
    }
  }
  port.postMessage({
    type: "audio_nodes",
    sources: sourceTitles,
    destinations: destinationTitles,
  });
};

const sendNodesToActivePopups = () => {
  activePopups.forEach((port) => {
    sendNodesToPopup(port);
  });
};

const handleNewFrameConnection_ = function (port) {
  var tab = port.sender.tab;
  if (!tab || !tab.id) {
    // We know not what tab this connection is coming from. It is degenerate.
    return;
  }
  const nodeId = getPortSenderTabId(port);
  const nodeTitle = getPortSenderTitle(port);

  nodes.set(nodeId, {
    port: port,
    id: nodeId,
    title: nodeTitle,
    isSource: false,
    isDestination: false,
    sourceActive: false,
    destinationActive: false,
  });

  // Listen to messages from the content script for the frame.
  port.onMessage.addListener(receiveFrameMessage);

  port.onDisconnect.addListener(removePort);
};

function receiveFrameMessage(message, port) {
  console.log("incoming message " + message.type, message, port);
  switch (message.type) {
    case "rtc_candidate":
      forwardRTCCandidate(message, port);
      break;
    case "rtc_offer":
      forwardRTCOffer(message, port);
      break;
    case "rtc_answer":
      forwardRTCAnswer(message, port);
      break;
    case "audio_source_available":
      storeSource(message, port);
      break;
    case "audio_destination_available":
      storeDestination(message, port);
      break;
    default:
      console.warn("unhandled message", message, port);
  }
}

function receivePopupMessage(message, port) {
  console.log("receivePopupMessage", message, port);
  switch (message.type) {
    case "mixer_update":
      updateMixer(message.data);
      break;
    case "refresh_nodes":
      sendNodesToPopup(port);
      break;
    case "mixer_gains":
      break;
    default:
      console.warn("unhandled popup message", message, port);
  }
}

function forwardRTCOffer(msg, port) {
  msg.portId = getPortSenderTabId(port); // keep track of the portId, the answer should go there
  mixer.destination && mixer.destination.port.postMessage(msg);
}

function forwardRTCAnswer(msg, port) {
  var otherPort = nodes.get(msg.portId);
  otherPort && otherPort.port.postMessage(msg);
}

function forwardRTCCandidate(msg, port) {
  mixer.destination && mixer.destination.port.postMessage(msg);
}

function storeSource(msg, port) {
  let id = getPortSenderTabId(port);
  if (id < 0) {
    // invalid source, should not happen
    return;
  }
  var node = nodes.get(id);
  if (node) {
    node.isSource = true;
    if (msg.title) {
      node.title = msg.title;
    }
    sendNodesToActivePopups();
  }
}

function storeDestination(msg, port) {
  let id = getPortSenderTabId(port);
  if (id < 0) {
    // invalid node, should not happen
    return;
  }
  var node = nodes.get(id);
  if (node) {
    node.isDestination = true;
    if (msg.title) {
      node.title = msg.title;
    }
    sendNodesToActivePopups();
  }
}

function removePort(port) {
  let id = getPortSenderTabId(port);
  console.log("port disconnect", port, id);
  if (id < 0) {
    console.warn("no tab?", port);
    return;
  }
  console.log("existing mixer", mixer);
  if (mixer.destination.id == id) {
    // mixer destination disconnected, disconnect everything
    resetMixer(id);
  } else {
    // check all sources, if in current mixer disconnect everything
    for (var sourceId of mixer.sources.keys()) {
      if (sourceId == id) {
        resetMixer(id);
        continue;
      }
    }
  }
  delete nodes.delete(id);
  sendNodesToActivePopups();
}

function resetMixer(skipId) {
  console.log("resetMixer", skipId, mixer);
  let msg = { type: "reset" };
  if (skipId === mixer.destination.id) {
  } else if (mixer.destination && mixer.destination.port) {
    try {
      mixer.destination.port.postMessage(msg);
      mixer.destination.destinationActive = false;
    } catch (ex) {
      console.warn("Error destination postMessage, probably disconnected", ex);
    }
  }
  for (var [sourceId, source] of mixer.sources.entries()) {
    if (skipId !== sourceId) {
      try {
        source.port.postMessage(msg);
        source.sourceActive = false;
      } catch (ex) {
        console.warn(
          "Error source postMessage, probably disconnected",
          sourceId,
          ex
        );
      }
    }
  }
  mixer.destination = { id: -1, port: undefined };
  mixer.sources = new Map();
}

function updateMixer(mixerMsg, port) {
  // mixerMsg should contain a list of sources and a single destination
  resetMixer();
  console.log(mixerMsg);
  if (!mixerMsg.destination) {
    console.error("no mixerMsg destination");
    return;
  }
  if (mixer.destination.id != mixerMsg.destination.id) {
    // new destination
    // ToDo iterate active sources and tell them to disconnect

    //
    let dest = nodes.get(mixerMsg.destination.id);
    if (!dest) {
      /// should not happen
      console.error("Destination disappeared?", mixerMsg.destination, nodes);
      return;
    }
    mixer.destination = dest;
    mixer.destination.destinationActive = true;
    // inform the destination, so it can await offers
    mixer.destination.port.postMessage({
      type: "audio_prepare_receive",
      mixer: mixerMsg,
    });
  }
  for (var i = mixerMsg.sources.length - 1; i >= 0; i--) {
    // should be only one
    let sourceId = mixerMsg.sources[i].id;
    if (mixer.sources.get(sourceId)) {
      // already connected
      continue;
    }
    let source = nodes.get(sourceId);
    if (!source) {
      console.warn("Invalid source", sourceId, mixerMsg, nodes);
      continue;
    }
    mixer.sources.set(sourceId, source);
    // each new source is asked to produce an RTC offer
    if (source.sourceActive) {
      // assume already connected, should not happen
    } else {
      // rtc_init triggers the offers
      source.port.postMessage({ type: "rtc_init" });
      source.sourceActive = true; // ToDo error handling
    }
  }
  //
}

function getPortSenderTabId(port) {
  if (!port || !port.sender || !port.sender.tab) {
    return -1;
  }
  return port.sender.tab.id + "_" + port.sender.frameId;
}

function getPortSenderTitle(port) {
  if (!port || !port.sender) {
    return "unknown";
  }
  if (port.sender.frameId) {
    // means we are not top-level, so tab title doesn't make sense
    let url = port.sender.url || "";
    return url.replace(/^https?\:\/\//i, "");
  } else {
    return port.sender.tab.title;
  }
}
