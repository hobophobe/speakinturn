/*
 * This file is based on the server example of aiortc.
 */

'use strict';

// Put variables in global scope to make them available to the browser console.
const audio = document.querySelector('audio');

const constraints = window.constraints = {
  audio: true,
  video: false
};

var dataChannelLog = document.getElementById('data-channel'),
    iceConnectionLog = document.getElementById('ice-connection-state'),
    iceGatheringLog = document.getElementById('ice-gathering-state'),
    signalingLog = document.getElementById('signaling-state');

var pc = null;
var apc = null;
var dc = null;
var canSend = false;


function createPeerConnection() {
    var config = {
        sdpSemantics: 'unified-plan'
    };

    var pc = new RTCPeerConnection(config);
    //pc.onnegotiationneeded = negotiate;

    // register some listeners to help debugging
    pc.addEventListener('icegatheringstatechange', function() {
        iceGatheringLog.textContent += ' -> ' + pc.iceGatheringState;
    }, false);
    iceGatheringLog.textContent = pc.iceGatheringState;

    pc.addEventListener('iceconnectionstatechange', function() {
        iceConnectionLog.textContent += ' -> ' + pc.iceConnectionState;
    }, false);
    iceConnectionLog.textContent = pc.iceConnectionState;

    pc.addEventListener('signalingstatechange', function() {
        signalingLog.textContent += ' -> ' + pc.signalingState;
    }, false);
    signalingLog.textContent = pc.signalingState;


    //pc.addEventListener('icegatheringstatechange')
    //pc.addEventListener('iceconnectionstatechange')
    //pc.addEventListener('signalingstatechange')
    //pc.addEventListener('track', function(e) {
        //audio.srcObject = e.streams[0];
    //});
    return pc;
}

function negotiate() {
    return pc.createOffer().then(function(offer) {
        return pc.setLocalDescription(offer);
    }).then(function() {
        return new Promise(function(resolve) {
            if (pc.iceGatheringState === 'complete') {
                resolve();
            } else {
                function checkState() {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange',
                                               checkState);
                        resolve();
                    }
                }
                pc.addEventListener('icegatheringstatechange', checkState);
            }
        });
    }).then(function(){
        var offer = pc.localDescription;
        document.getElementById('offer-sdp').textContent = offer.sdp;
        return fetch('/offer', {
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type
            }),
            headers: {
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });
    }).then(function(response) {
        return response.json();
    }).then(function(answer) {
        document.getElementById('answer-sdp').textContent = answer.sdp;
        return pc.setRemoteDescription(answer);
    }).catch(function(e){
        alert(e);
    });
}

/** Duties and expectations
 * Expectations:
 * 1. Will receive update of place in queue
 * 2. Users may be stopped during speaking
 * 
 * Duties:
 * 1. Join queue
 * 2. Leave queue
 * 3. Speak when activated
 * 4. Check status
 */

function status() {
    sendMessage('status-check');
}

function sendMessage(message) {
    if (canSend) {
        dataChannelLog.textContent += '> ' + message + '\n';
        dc.send(message);
    }
}

function queue() {
    pc = createPeerConnection();

    dc = pc.createDataChannel('chat', { "ordered": true });
    dc.onclose = function() {
        canSend = false;
    };
    dc.onopen = function() {
        canSend = true;
        sendMessage('enterqueue');
    };
    dc.onmessage = function(e) {
        dataChannelLog.textContent += '< ' + e.data + '\n';
        if (e.data === 'ready') {
            // FIXME remove queue position
            audioStart();
            document.getElementById('queue-status').textContent = "Live";
        } else if (e.data.substring(0, 8) === 'position') {
            document.getElementById('queue-status').textContent =
                e.data.substring(9);
        } else if (e.data === 'bumped') {
            unqueue(true);
        }
    };

    // We create this now, rather than when the client is "called on"
    // This is because we have to have the audio stream in our
    // initial connection or it will fail on renegotiating in Firefox
    // (Because Firefox insanely sends an RTP Goodbye packet upon opening
    //    the audio stream when done from renegotiation (BZ: 1232234))
    // This could alternatively be done by creating a separate PC at
    // the time the client is called on.
    //navigator.mediaDevices.getUserMedia(constraints).then(
        //function(stream) {
            //stream.getTracks().forEach(function(track) {
                //pc.addTrack(track, stream);
            //});
        //},
        //function(err) {
            //alert('Could not acquire media: ' + err);
        //});

    negotiate();
}

function unqueue(byRemote) {
    audioStop();

    if (dc) {
        if (!byRemote) {
            sendMessage('leaving');
            // to prevent it from trying to reconnect
        }
        dc.close();
    }

    setTimeout(function() {
        pc.close();
    }, 5000);
}

function audioNegotiate() {
    return apc.createOffer().then(function(offer) {
        return apc.setLocalDescription(offer);
    }).then(function() {
        return new Promise(function(resolve) {
            if (apc.iceGatheringState === 'complete') {
                resolve();
            } else {
                function checkState() {
                    if (apc.iceGatheringState === 'complete') {
                        apc.removeEventListener('icegatheringstatechange',
                                                checkState);
                        resolve();
                    }
                }
                apc.addEventListener('icegatheringstatechange', checkState);
            }
        });
    }).then(function(){
        var offer = apc.localDescription;
        return fetch('/audio_offer', {
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type
            }),
            headers: {
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });
    }).then(function(response) {
        return response.json();
    }).then(function(answer) {
        return apc.setRemoteDescription(answer);
    }).catch(function(e){
        alert(e);
    });
}

function createAudioPeerConnection() {
    var config = {
        sdpSemantics: 'unified-plan'
    };

    var apc = new RTCPeerConnection(config);
    return apc;
}

function audioStart() {
    apc = createAudioPeerConnection();

    navigator.mediaDevices.getUserMedia(constraints).then(
        function(stream) {
            stream.getTracks().forEach(function(track) {
                apc.addTrack(track, stream);
            });
        },
        function(err) {
            alert('Could not acquire media: ' + err);
        }).then(audioNegotiate);
}

function audioStop() {
    if (!apc) {
        // nothing to do
        return;
    }

    if (apc.getTransceivers) {
        apc.getTransceivers().forEach(function(transceiver) {
            if (transceiver.stop) {
                transceiver.stop();
            }
        });
    }

    apc.getSenders().forEach(function(sender) {
        sender.track.stop();
    });

    setTimeout(function() {
        apc.close();
    }, 500);
}

