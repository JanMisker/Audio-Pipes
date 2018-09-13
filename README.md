# Audio Pipes
Chrome extension to redirect WebAudio between webpages.

Published as a [Chrome extension](https://chrome.google.com/webstore/detail/audio-pipes/ebmfdpppokkplmndpamkhbmochcdlefp)

Demo video: https://vimeo.com/267083951 

## Intro
Audio Pipes is a chrome extension that makes it possible to stream audio between any webpage that utilizes web audio. A script is injected on a webpage that checks whether audio is produced or consumed on the page. The user can then select which pages to connect, after which a WebRTC connection is made between those pages. 

There are many applications that utilize web audio to produce sound and music, for example sequencers, synthesizer emulators or applying effects to microphone input. However, the audio that is produced hardly ever can be used elsewhere. Sometimes there is an option to export as a wave file, but a real time connection is not possible within the browser. There are ways on the level of the operating system to redirect audio between processes, but this requires a lot of tinkering and is out of reach for regular users.

We were inspired by the [Web Audio inspector extension for Chrome](https://github.com/google/audion), which generates a visual representation of the audio nodes on a webpage. We developed an extension that makes it possible to use any webpage that generates audio and connect it to any webpage that consumes audio from the microphone. There are no changes needed to the Javascript code on the webpage, i.e. it works on all webpages.

## Technical Description
### Extension to bypass security sandbox
An important security consideration when employing Web Audio is that for obvious reasons all usage of the microphone requires explicit approval of the user. Cross-site scripting attacks are thus especially important to protect against on pages that request microphone input. However for our use case we need to be able to tap into the microphone input, and other aspects of Web Audio.

Scripts that run as part of an extension have a way to get access to the sandbox of any page, by injecting scripts in the page head. This technique is used by the Web Audio Inspector as well.

The background page of an extension keeps it state as long as the browser runs, and gets notified of all new pages the user opens. We inject a content script on all pages that looks for the use of relevant Web Audio function calls on the page. If the page consumes or produces audio, this is stored in the central background page.

### WebRTC to stream between pages
WebRTC is a technology that makes it possible to set up real time media streams between browsers. The most appealing use case is video conferencing in the browser, with bi-directional video and audio streams, not obstructed by specifics of the networks the users are on. The media streams can connect directly between clients, or using pass through proxies, but in order to establish these connections, there is still need for a central lookup service. This so called signaling server is used to initiate the calls and exchange the information required for the connections.

In our extension we use the background page as the signaling service to set up a one-way audio stream. Messages are passed using normal window messaging mechanism.

### Putting it all together
The script that is injected on all pages keeps track of where audio is produced or consumed. This is achieved by replacing certain functions on the AudioContext prototype and other related prototypes. There are two flows, one for the AudioContext destination and one for the microphone input.

Figure 1 provides a schematic overview of the Audio Pipes architecture. The gray parts are normal Web Audio elements that are bypassed and muted when a connection is made between two webpages.
When an AudioContext is created, a dummy destination is created; a GainNode connected to the real destination. Every call on AudioNode.connect is intercepted, when it wants to connect to thedestination, it is instead connected to the dummy destination. A similar process intercepts calls to getUserMedia and createMediaStreamSource to have a dummy input stream.

The user can select from the pages that have these dummy output and input streams. The audio output of a page is a source for the input of another page, i.e. the latter is a destination. When the user indicate that a source and destination have to be connected, a WebRTC connection is established. On the source page, the dummy AudioContext destination stream is connected to an RTCPeerConnection, and the stream to the original destination is muted. On the destination page, the incoming stream is connected to the dummy input, and the microphone input stream is muted.

## Credits
This project was developed by Jan Misker as part of the [Watch That Sound platform](www.watchthatsound.nl).
License tbd
