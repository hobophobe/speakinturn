# Autopsy of Speak in Turn

## The Idea

Many conference talks let audience members ask questions at the end. The various protocols to handle that portion of a talk all have friction. But some portion of the audience has a wireless microphone with them (either a mobile or a laptop), so wouldn't it be great to let them queue up and ask questions using their mobiles or laptops?

## The Attempt

I used the Python package `aiortc` for the server portion, on the premise it could easily record or route the incoming audio to a soundboard. There are three components in this setup:

1. Server (based on the server example that ships with `aiortc`)
2. Control (HTML+Javascript, based on the same example)
3. Client (HTML+Javascript, based on the same example)

The Control client connects to the server, is told of clients in the queue, and controls when their microphones are live.

The clients queue up and, when they are live, an audio stream+track is sent to the server from their microphone.

## The Problems

First off, the `aiortc` example server worked on all platforms I tried it with:

1. Desktop Firefox
2. Mobile Firefox
3. Desktop Chromium

I would have tried Mobile Chrome/Chromium but they don't let you send audio without encryption, and I didn't want to bother configuring it for the server.

`aiortc` doesn't support renegotiation by default (with their events), so I modified their server example to do so. This worked with Chromium on Desktop. Unfortunately, with Firefox, a bug:

> Firefox's implementation of webrtc (bz:1232234) that causes it to send an RTP:Goodbye packet as soon as a MediaStream is opened on a renegotiated connection.

So I tried setting up a dedicated connection just for audio. Here, I either missed something or perhaps another bug somehow, because the connections were correctly firing the `track` event when the audio was started, but they would not fire `ended` when they received the RTP:Goodbye packet that should end the audio track.

(This is the point where I gave up. Using a different language/package might have fared better, but `aiortc` seemed solid to me. More likely, someone with experience with webrtc could have had an easier time getting it to work.)

## The Bright Side

Setting up the data channels works on all platforms. While I don't know if better options exist, it seems like using webrtc data channels could be useful for other mobile-to-mobile or server-to-mobile coordination purposes. For example, for simple, impromptu LARP signaling from a DM, or for restaurants that want to use it for a simple waiting-for-your-table system.

-----

If anyone wants to work with this code, the requirements:

    pip install aiohttp aiortc opencv-python

aiortc apparently requires:

    sudo apt install libavdevice-dev libavfilter-dev libopus-dev libvpx-dev pkg-config

Then it's just:

    python3 speakinturn.py

Options are documented at the bottom of that file, as taken from `aiortc`'s example server.

Server endpoints are:

1. localhost:8080 - Client connection point
2. localhost:8080/control - Control Client connection point

The others are used to POST connection offers to the server.
