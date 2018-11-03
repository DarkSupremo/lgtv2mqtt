#!/usr/bin/env node

const Mqtt = require('mqtt')
const Lgtv = require('lgtv2')
const pkg = require('./package.json')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const wol = require('wol')

let tvOn
let requestedTVOn = null
let mqttConnected
let tvConnected
let lastError

require('homeautomation-js-lib/mqtt_helpers.js')

const tvMAC = process.env.TV_MAC
const tvIP = process.env.TV_IP

var topic_prefix = process.env.TOPIC_PREFIX

if (_.isNil(topic_prefix)) {
	logging.warn('TOPIC_PREFIX not set, not starting')
	process.abort()
}


logging.info(pkg.name + ' ' + pkg.version + ' starting')

const mqtt = Mqtt.setupClient(function() {
	mqttConnected = true

	mqtt.publish(topic_prefix + '/connected', tvConnected ? '1' : '0', {retain: true})

	logging.info('mqtt subscribe', topic_prefix + '/set/#')
	mqtt.subscribe(topic_prefix + '/set/#')
}, function() {
	if (mqttConnected) {
		mqttConnected = false
		logging.error('mqtt disconnected')
	}
})

const powerOff = function() {
	logging.info('powerOff (isOn? ' + tvOn + ')')
	if ( tvOn ) { 
		logging.info('lg > ssap://system/turnOff')
		lgtv.request('ssap://system/turnOff', null, null) 
		tvOn = false
		requestedTVOn = false
	}
}

const lgtv = new Lgtv({
	url: 'ws://' + tvIP + ':3000',
	reconnect: 5000
})

mqtt.on('error', err => {
	logging.error('mqtt', err)
})

mqtt.on('message', (inTopic, inPayload) => {
	var topic = inTopic
	var payload = String(inPayload)
	try {
		payload = JSON.parse(payload)
	} catch (err) {
		logging.error('error on mqtt message JSON parsing: ' + err)
	}

	logging.debug('mqtt <', topic, payload)

	if (topic[0] == '/') { 
		topic = topic.substring(1)
	}
      
	const parts = topic.split('/')

	switch (parts[1]) {
		case 'set':
			switch (parts[2]) {
				case 'toast':
					lgtv.request('ssap://system.notifications/createToast', {message: String(payload)})
					break
				case 'volume':
					lgtv.request('ssap://audio/setVolume', {volume: parseInt(payload, 10)} || 0)
					break
				case 'mute':
					if (payload === 'true') {
						payload = true
					}
					if (payload === 'false') {
						payload = false
					}
					lgtv.request('ssap://audio/setMute', {mute: Boolean(payload)})
					break
            
				case 'input':
					logging.info('lg > ssap://tv/switchInput', {inputId: String(payload)})
					lgtv.request('ssap://tv/switchInput', {inputId: String(payload)})
					break

				case 'launch':
					lgtv.request('ssap://system.launcher/launch', {id: String(payload)})
					break

				case 'powerOn':
					logging.info('powerOn (isOn? ' + tvOn + ')')
					wol.wake(tvMAC, function(err, res) {
						logging.info('WOL: ' + res)
						tvOn = true
						requestedTVOn = true
					})

					// if ( !tvOn ) { 
					// 	logging.info('lg > ssap://system/turnOff')
					// 	lgtv.request('ssap://system/turnOff', null, null) 
					// 	tvOn = true
					// }
					break

				case 'powerOff':
					powerOff()
					break

				case 'button':
					/*
                     * Buttons that are known to work:
                     *    MUTE, RED, GREEN, YELLOW, BLUE, HOME, MENU, VOLUMEUP, VOLUMEDOWN,
                     *    CC, BACK, UP, DOWN, LEFT, ENTER, DASH, 0-9, EXIT
                     *
                     * Probably also (but I don't have the facility to test them):
                     *    CHANNELUP, CHANNELDOWN
                     */
					sendPointerEvent('button', {name: (String(payload)).toUpperCase()})
					break

				default:
					logging.info('lg > ' + 'ssap://' + inPayload)
					lgtv.request('ssap://' + inPayload, null, null)
			}
			break
		default:
	}
})

lgtv.on('prompt', () => {
	logging.info('authorization required')
})

lgtv.on('connect', () => {
	tvOn = true
	let channelsSubscribed = false
	lastError = null
	tvConnected = true
	logging.info('tv connected')
	mqtt.publish(topic_prefix + '/connected', '1', {retain: true})

	lgtv.subscribe('ssap://audio/getVolume', (err, res) => {
		logging.info('audio/getVolume', err, res)
		if (res.changed.indexOf('volume') !== -1) {
			mqtt.publish(topic_prefix + '/status/volume', String(res.volume), {retain: true})
		}
		if (res.changed.indexOf('muted') !== -1) {
			mqtt.publish(topic_prefix + '/status/mute', res.muted ? '1' : '0', {retain: true})
		}
	})

	lgtv.subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (err, res) => {
		logging.info('getForegroundAppInfo', err, res)
		mqtt.publish(topic_prefix + '/status/foregroundApp', String(res.appId), {retain: true})

		if ( !_.isNil(res.appId) && res.appId.length > 0) {
			tvOn = true
		} else {
			tvOn = false
		}

		if (res.appId === 'com.webos.app.livetv') {
			if (!channelsSubscribed) {
				channelsSubscribed = true
				setTimeout(() => {
					lgtv.subscribe('ssap://tv/getCurrentChannel', (err, res) => {
						if (err) {
							logging.error(err)
							return
						}
						const msg = {
							val: res.channelNumber,
							lgtv: res
						}
						mqtt.publish(topic_prefix + '/status/currentChannel', JSON.stringify(msg), {retain: true})
					})
				}, 2500)
			}
		}
	})

	lgtv.subscribe('ssap://tv/getExternalInputList', function(err, res) {
		logging.info('getExternalInputList', err, res)
	})

	if ( requestedTVOn == false ) {
		powerOff()
	}
})

lgtv.on('connecting', host => {
	logging.debug('tv trying to connect', host)
})

lgtv.on('close', () => {
	lastError = null
	tvConnected = false
	logging.info('tv disconnected')
	mqtt.publish(topic_prefix + '/connected', '0', {retain: true})
})

lgtv.on('error', err => {
	const str = String(err)
	if (str !== lastError) {
		logging.error('tv', str)
	}
	lastError = str
})

const sendPointerEvent = function(type, payload) {
	lgtv.getSocket(
		'ssap://com.webos.service.networkinput/getPointerInputSocket',
		(err, sock) => {
			if (!err) {
				sock.send(type, payload)
			}
		}
	)
}
