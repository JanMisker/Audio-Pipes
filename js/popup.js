(function ($) {
  $(document).ready(function () {
    function handleMessageFromBackground(msg) {
      if (!msg) {
        return;
      }
      switch (msg.type) {
        case "audio_nodes":
          updateNodes(msg);
          break;
        default:
          console.log("Incoming", msg);
          break;
      }
    }

    var backgroundPageConnection = chrome.runtime.connect({
      name: "popup",
    });
    backgroundPageConnection.onMessage.addListener(handleMessageFromBackground);

    $("#refresh").click(function (evt) {
      backgroundPageConnection.postMessage({
        type: "refresh_nodes",
      });
    });

    // localize strings
    document.getElementById("update").innerText =
      chrome.i18n.getMessage("button_apply");
    document.getElementById("title_sources").innerText =
      chrome.i18n.getMessage("title_sources");
    document.getElementById("title_destinations").innerText =
      chrome.i18n.getMessage("title_destinations");

    $("#update").click(function (evt) {
      // iterate sources and destinations
      let mixer = {
        sources: [],
        destination: undefined,
      };
      mixer.sources = jQuery.makeArray(
        $("#sources input:checked").map(function (idx, item) {
          return { id: item.value };
        })
      );
      if (!mixer.sources.length) {
        alert(chrome.i18n.getMessage("alert_no_source"));
      }
      let dest = $("#destinations input:checked");
      if (!dest.length) {
        alert(chrome.i18n.getMessage("alert_no_destination"));
        return;
      }
      mixer.destination = { id: dest.attr("value") };
      console.log(mixer);
      backgroundPageConnection.postMessage({
        type: "mixer_update",
        data: mixer,
      });
    });

    function updateNodes(nodes) {
      // list is still empty
      let sourcesUL = $("#sources");
      let destinationsUL = $("#destinations");
      sourcesUL.empty();
      destinationsUL.empty();
      for (var i = 0; i < nodes.sources.length; i++) {
        let node = nodes.sources[i];
        let input = $(
          '<input type="radio" name="sources" value="' +
            node.id +
            '" id="source_' +
            i +
            '" />'
        );
        if (node.active) {
          input.attr("checked", "checked");
        }
        let label = $(
          '<label for="source_' + i + '">' + node.title + "</label>"
        );
        let li = $("<li>");
        // label.prepend(input);
        li.append(input);
        li.append(label);
        sourcesUL.append(li);
      }
      for (var i = 0; i < nodes.destinations.length; i++) {
        let node = nodes.destinations[i];
        let input = $(
          '<input type="radio" name="destinations" value="' +
            node.id +
            '" id="destination_' +
            i +
            '" />'
        );
        if (node.active) {
          input.attr("checked", "checked");
        }
        let label = $(
          '<label for="destination_' + i + '">' + node.title + "</label>"
        );
        let li = $("<li>");
        li.append(input);
        // label.prepend(input);
        li.append(label);
        destinationsUL.append(li);
      }
      $("#update").attr(
        "disabled",
        $("#sources input:checked").length === 0 ||
          $("#destinations input:checked").length === 0
      );
    }

    $(document).on("change", "input", () => {
      $("#update").attr(
        "disabled",
        $("#sources input:checked").length === 0 ||
          $("#destinations input:checked").length === 0
      );
    });
  });
})(jQuery);
