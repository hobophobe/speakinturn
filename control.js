/*
 * This file is based on the server example of aiortc.
 */

'use strict';

// Put variables in global scope to make them available to the browser console.
const audio = document.querySelector('audio');

const constraints = window.constraints = {
  audio: false,
  video: false
};

var pc = null;
var dc = null;
var dcInterval = null;

function createPeerConnection() {
    var config = {
        sdpSemantics: 'unified-plan'
    };

    var pc = new RTCPeerConnection(config);
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
        return fetch('/control_offer', {
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
        document.getElementById('ready-sdp').textContent = answer.sdp;
        return pc.setRemoteDescription(answer);
    }).catch(function(e){
        alert(e);
    });
}

/** Duties and expectations
 * Expectations:
 * 1. Users are added automatically (by user joining)
 * 2. Users can leave automatically (by user parting)
 * 
 * Duties: (! = unimplemented server-side)
 * 1. !Start the queue (go live)
 * 2. !Halt the queue
 * 3. Choose to activate a user
 * 4. Choose to stop active user
 * 5. Choose (implicitly) to stop active user by activating a different user
 */


function goLive() {
    pc = createPeerConnection();

    dc = pc.createDataChannel('chat', { "ordered": true });
    dc.onclose = function() {};
    dc.onopen = function() {
        dc.send('live');
        status('live');
    };
    dc.onmessage = function(e) {
        if (e.data.substring(0,3) === 'add') {
            var id = e.data.substring(4);
            addToQueue(id);
        } else if (e.data.substring(0, 3) === 'rem') {
            var id = e.data.substring(4);
            removeFromQueue(id);
        } else if (e.data.substring(0, 4) === 'done') {
            var id = e.data.substring(5);
            removeActive(id);
        } else if (e.data.substring(0, 6) === 'active') {
            var id = e.data.substring(7);
            markActive(id);
        }
    };
    negotiate();
}

function shutdown() {
    if (dc) {
        dc.send('halt');
        status('down');
        dc.close();
    }

    if (pc.getTransceivers) {
        pc.getTransceivers().forEach(function(transceiver) {
            if (transceiver.stop) {
                transceiver.stop();
            }
        });
    }

    //pc.getSenders().forEach(function(sender){
        //sender.track.stop();
    //});

    setTimeout(function(){
        pc.close();
    }, 500);
}

function status(state) {
    document.getElementById('status').textContent = state;
}

function addToQueue(id) {
    var queue = document.getElementById('active-queue');
    var queue_el = document.createElement('div');
    queue_el.classList.add('queue-member');
    queue_el.setAttribute('id', 'queue-' + id);
    queue_el.textContent = id;
    queue_el.dataset.id = id;
    queue_el.addEventListener('click', activateUser);
    queue.appendChild(queue_el);
}

function removeFromQueue(id) {
    if (getActiveId() === id) {
        removeActive(id);
    } else {
        var queue_el = document.getElementById('queue-' + id);
        queue_el.parentNode.removeChild(queue_el);
    }
}

function activateUser(e) {
    var id = e.target.dataset.id;
    var active = document.getElementById('active-speaker');
    if (active.dataset.id) {
        bump(active.dataset.id);
    }
    active.dataset.id = id;
    document.getElementById('active-id').textContent = id;
    var stopButton = document.getElementById('done-speaking');
    stopButton.style.display =  'inline-block';
    dc.send('activate ' + id);
}

function markActive(id) {
    var active = document.getElementById('active-speaker');
    active.dataset.id = id;
    var stopButton = document.getElementById('done-speaking');
    stopButton.style.display =  'inline-block';
    document.getElementById('active-id').textContent = id;
}

function removeActive(id) {
    var active = document.getElementById('active-speaker');
    delete active.dataset.id;
    document.getElementById('active-id').textContent = "";
    var stopButton = document.getElementById('done-speaking');
    stopButton.style.display =  'none';
    var active_queue_el = document.getElementById('queue-' + id);
    active_queue_el.parentNode.removeChild(active_queue_el);

}

function bump(id) {
    dc.send('deactivate ' + id);
}

function getActiveId() {
    var active = document.getElementById('active-speaker');
    return active.dataset.id;
}

function bumpActive() {
    var id = getActiveId();
    bump(id);
    removeActive(id);
}

