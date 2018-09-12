
if (window == window.top) {
  /// only top level


  var injectScript = function(url) {
    var scriptTag = document.createElement('script');
    // scriptTag.textContent = scrpt;
    scriptTag.src = url;
    (document.head || document.documentElement).appendChild(scriptTag);
    // scriptTag.remove();
  }

  // injectScript(chrome.extension.getURL('js/tracing.js'));
  injectScript(chrome.extension.getURL('js/rtc.js'));

  var handleMessageFromBackground_ = function(message) {
    if (!message) {
      return;
    }

    // Relay any messages from the background page to the window. Label it as from
    // this extension first.
    message = (message);
    message.tag = 'AudioPipesToPage';

    window.postMessage(message, window.location.origin || '*');
  }

  var backgroundPageConnection = chrome.runtime.connect({
      'name': 'init_frame'
    });
  backgroundPageConnection.onMessage.addListener(handleMessageFromBackground_);

  // Listen to messages from the page. Relay them to the background script.
  window.addEventListener('message', function(event) {
  	// console.log('content script got a message', event);
      if (event.source != window) {
        // We are not interested in messages from other windows.
        return;
      }

      var message = (event.data);
      if (!message ||
           message.tag != 'AudioPipesToBackground') {
        // This message is not relevant to this extension.
        return;
      }

      // We do not need the tag that identifies this message as from this
      // extension if we are communicating with the background page. Prefer a
      // smaller message (for serialization).
      delete message.tag;
      backgroundPageConnection.postMessage(message);
  });

  // Tell the background page that this content script is ready to receive
  // messages. 
  // backgroundPageConnection.postMessage({
  //     type: 'yo'
  // });

}
