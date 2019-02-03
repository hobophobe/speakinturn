
#
# * This file is based on the server example of aiortc.
#

import argparse
import asyncio
import json
import logging
import os
import ssl
import uuid

import cv2
from aiohttp import web

from aiortc import RTCPeerConnection, RTCSessionDescription, sdp
from aiortc.contrib.media import MediaBlackhole, MediaPlayer, MediaRecorder

ROOT = os.path.dirname(__file__)

logger = logging.getLogger('pc')
controller = None
next_id = 1

async def control(request):
    content = open(os.path.join(ROOT, 'control.html'), 'r').read()
    return web.Response(content_type='text/html', text=content)

async def control_js(request):
    content = open(os.path.join(ROOT, 'control.js'), 'r').read()
    return web.Response(content_type='application/javascript', text=content)


async def index(request):
    content = open(os.path.join(ROOT, 'index.html'), 'r').read()
    return web.Response(content_type='text/html', text=content)

async def client_js(request):
    content = open(os.path.join(ROOT, 'client.js'), 'r').read()
    return web.Response(content_type='application/javascript', text=content)


async def stylesheet(request):
    content = open(os.path.join(ROOT, 'speakinturn.css'), 'r').read()
    return web.Response(content_type='text/css', text=content)


class SpeakController:
    def __init__(self, audio_filename):
        self.control = None
        self.queue = []
        self.queue_id = []
        self.active_user = None
        self.spool = []
        self.audio_filename = audio_filename

    def client_from_origin(self, origin):
        relevant_part = origin.split(' ')[1]
        new_rel_part = None
        for client in self.queue:
            desc = sdp.SessionDescription.parse(
                client.pc.remoteDescription.sdp)
            new_rel_part = desc.origin.split(' ')[1]
            if new_rel_part == relevant_part:
                idx = self.queue.index(client)
                print('Renegotiation by {}'.format(relevant_part))
                return client
        print('Not a renegotiation ({} != {})'.format(
            relevant_part, new_rel_part))
        return None

    async def add(self, client):
        global next_id
        new_user_id = next_id
        next_id += 1
        self.queue.append(client)
        self.queue_id.append(new_user_id)
        client.user_id = new_user_id

        # Notify self.control of a new user
        await self.control.send('add {}'.format(new_user_id))

        # Notify pc of its spot in queue
        await client.send('position {}'.format(len(self.queue)))

    async def control_rem(self, rem_user_id):
        idx = self.queue_id.index(rem_user_id)
        exclient = self.queue.pop(idx)
        self.queue_id.pop(idx)
        if self.active_user is exclient:
            self.active_user = None

        # Notify pc of being dropped
        await exclient.send('bumped')
        # Notify others of new queue position
        if idx < len(self.queue):
            # we don't notify if they were the last one
            position = idx
            for client in self.queue[idx:]:
                await client.send('position {}'.format(position + 1))
                position += 1

    async def status(self, client):
        idx = self.queue_id.index(client.user_id)
        await client.send('position {}'.format(idx + 1))

    async def user_rem(self, exclient):
        if self.active_user is exclient:
            self.active_pc = None

        try:
            idx = self.queue.index(exclient)
        except ValueError:
            # already removed, we hope.
            return
        self.queue.pop(idx)
        self.queue_id.pop(idx)

        # Notify controller user has dropped
        await self.control.send('rem {}'.format(exclient.user_id))

        # Notify others of new positions
        if idx < len(self.queue):
            # we don't notify if they were the last one
            position = idx
            for client in self.queue[idx:]:
                await client.send('position {}'.format(position + 1))
                position += 1

    async def activate(self, user_id):
        idx = self.queue_id.index(user_id)
        client = self.queue[idx]
        self.active_user = client
        # Notify user they're up
        await client.send('ready')

    # Unused
    async def update_control(self):
        # If control lost connection, notify it what's up
        # We could serialize this, but for now just send single messages

        for user_id in self.queue_id:
            await self.control.send('add {}'.format(user_id))
        if self.active_user:
            await self.control.send('active {}'.format(
                self.active_user.user_id))

    async def shutdown(self):
        coros = [client.pc.close() for client in self.queue]
        await asyncio.gather(*coros)
        if self.active_user and self.active_user.audio_client:
            await self.active_user.audio_client.pc.close()
        await self.control.pc.close()



class SpeakControl:
    def __init__(self, controller):
        self.controller = controller
        pc = RTCPeerConnection()
        self.pc = pc
        self.channel = None
        self.pcid = 'Control PeerConnection(%s)' % uuid.uuid4()
        controller.control = self
        self.spool = []
        @pc.on('datachannel')
        async def on_datachannel(channel):
            self.channel = channel
            @channel.on('message')
            async def on_message(message):
                if isinstance(message, str):
                    self.log_info(message)
                    if message.startswith('deactivate'):
                        user_id = int(message[11:])
                        await self.controller.control_rem(user_id)
                    elif message.startswith('activate'):
                        user_id = int(message[9:])
                        await self.controller.activate(user_id)

        @pc.on('iceconnectionstatechange')
        async def on_iceconnectionstatechange():
            self.log_info(
                'Control ICE connection state is %s', pc.iceConnectionState)
            if pc.iceConnectionState == 'failed':
                await pc.close()

    def log_info(self, msg, *args):
        logger.info(self.pcid + ' ' + msg, *args)

    async def send(self, message):
        if not self.channel:
            self.spool.append(message)
        else:
            for spool_message in self.spool:
                self.channel.send(spool_message)
            self.spool = []
            self.channel.send(message)


class SpeakClient:
    def __init__(self, controller):
        pc = RTCPeerConnection()
        self.pc = pc
        self.controller = controller
        self.channel = None
        self.pcid = 'PeerConnection(%s)' % uuid.uuid4()
        self.user_id = None
        self.audio_client = None
        self.spool = []

        @pc.on('datachannel')
        async def on_datachannel(channel):
            self.channel = channel
            @channel.on('message')
            async def on_message(message):
                if isinstance(message, str):
                    self.log_info(message)
                    if message.startswith('leaving'):
                        await self.controller.user_rem(self)
                    elif message.startswith('status-check'):
                        await self.controller.status(self)

        @pc.on('iceconnectionstatechange')
        async def on_iceconnectionstatechange():
            self.log_info('ICE connection state is %s', pc.iceConnectionState)
            if pc.iceConnectionState == 'failed':
                # Treat a failure as user removing emself?
                #await controller.user_rem(pc)
                await pc.close()

    def add_audio_client(self, audio_client):
        self.audio_client = audio_client

    def log_info(self, msg, *args):
        logger.info(self.pcid + ' ' + msg, *args)

    async def send(self, message):
        if not self.channel:
            self.spool.append(message)
        else:
            for spool_message in self.spool:
                self.channel.send(spool_message)
            self.spool = []
            self.channel.send(message)


class AudioClient:
    def __init__(self, client):
        self.client = client
        client.add_audio_client(self)
        pc = RTCPeerConnection()
        self.pc = pc
        self.controller = controller
        self.pcid = 'PeerConnection(%s)' % uuid.uuid4()
        self.user_id = client.user_id

        self.recorder = None
        filename_parts = self.client.controller.audio_filename.split('.')
        filename_parts[0] += str(self.user_id)
        new_filename = '.'.join(filename_parts)
        recorder = MediaRecorder(new_filename)
        self.recorder = recorder

        #self.add_recorder(self.client.controller.audio_filename)

        @pc.on('iceconnectionstatechange')
        async def on_iceconnectionstatechange():
            self.log_info('ICE connection state is %s', pc.iceConnectionState)
            if pc.iceConnectionState == 'failed':
                # Treat a failure as user removing emself?
                #await controller.user_rem(pc)
                await pc.close()

        @pc.on('track')
        async def on_track(track):
            self.log_info('Track %s received', track.kind)

            if track.kind == 'audio':
                recorder.addTrack(track)

            @track.on('ended')
            async def on_ended():
                self.log_info('Track %s ended', track.kind)
                #await asyncio.sleep(5)
                await recorder.stop()

    def log_info(self, msg, *args):
        logger.info(self.pcid + ' ' + msg, *args)

    def add_recorder(self, filename):
        if filename is None:
            return
        filename_parts = filename.split('.')
        filename_parts[0] += str(self.user_id)
        new_filename = '.'.join(filename_parts)
        self.recorder = MediaRecorder(new_filename)


async def control_offer(request):
    global controller
    if not controller:
        controller = SpeakController(args.write_audio)
    control = SpeakControl(controller)
    params = await request.json()
    offer = RTCSessionDescription(
        sdp=params['sdp'],
        type=params['type'])

    control.log_info('Controller created for %s', request.remote)

    # handle offer
    await control.pc.setRemoteDescription(offer)

    # send answer
    answer = await control.pc.createAnswer()
    await control.pc.setLocalDescription(answer)

    return web.Response(
        content_type='application/json',
        text=json.dumps({
            'sdp': control.pc.localDescription.sdp,
            'type': control.pc.localDescription.type
        }))


async def offer(request):
    global controller
    if not controller:
        controller = SpeakController(args.write_audio)
    params = await request.json()
    offer = RTCSessionDescription(
        sdp=params['sdp'],
        type=params['type'])

    # Try to get existing client, to make this a renegotiation
    description = sdp.SessionDescription.parse(offer.sdp)
    origin = description.origin
    client = controller.client_from_origin(origin)


    if client is None:
        client = SpeakClient(controller)
        await controller.add(client)

    # handle offer
    await client.pc.setRemoteDescription(offer)

    # send answer
    answer = await client.pc.createAnswer()
    await client.pc.setLocalDescription(answer)

    return web.Response(
        content_type='application/json',
        text=json.dumps({
            'sdp': client.pc.localDescription.sdp,
            'type': client.pc.localDescription.type
        }))

async def audio_offer(request):
    global controller
    if not controller:
        controller = SpeakController(args.write_audio)
    params = await request.json()
    offer = RTCSessionDescription(
        sdp=params['sdp'],
        type=params['type'])

    audio_client = AudioClient(controller.active_user)

    # handle offer
    await audio_client.pc.setRemoteDescription(offer)
    await audio_client.recorder.start()

    # send answer
    answer = await audio_client.pc.createAnswer()
    await audio_client.pc.setLocalDescription(answer)

    return web.Response(
        content_type='application/json',
        text=json.dumps({
            'sdp': audio_client.pc.localDescription.sdp,
            'type': audio_client.pc.localDescription.type
        }))


async def on_shutdown(app):
    global controller
    # close peer connections
    await controller.shutdown()
    #await asyncio.gather(controller.control)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='WebRTC audio / video / data-channels demo')
    parser.add_argument('--cert-file', help='SSL certificate file (for HTTPS)')
    parser.add_argument('--key-file', help='SSL key file (for HTTPS)')
    parser.add_argument('--port', type=int, default=8080,
                        help='Port for HTTP server (default: 8080)')
    parser.add_argument('--verbose', '-v', action='count')
    parser.add_argument('--write-audio', help='Write received audio to a file')
    args = parser.parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)

    if args.cert_file:
        ssl_context = ssl.SSLContext()
        ssl_context.load_cert_chain(args.cert_file, args.key_file)
    else:
        ssl_context = None

    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get('/', index)
    app.router.add_get('/control', control)
    app.router.add_get('/client.js', client_js)
    app.router.add_get('/control.js', control_js)
    app.router.add_get('/speakinturn.css', stylesheet)
    app.router.add_post('/offer', offer)
    app.router.add_post('/audio_offer', audio_offer)
    app.router.add_post('/control_offer', control_offer)
web.run_app(app, access_log=None, port=args.port, ssl_context=ssl_context)