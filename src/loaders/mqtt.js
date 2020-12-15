///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const mqtt = require('mqtt');
const logger = require('./logger'); // Moved to own module
const updateDeviceState = require('../services/state').updateDeviceState;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
// MQTT ENV variables========================
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
// Shared Array Object for Alexa/ GHome Commands that are un-acknowledged
var ongoingCommands = {};
///////////////////////////////////////////////////////////////////////////
// MQTT Client Configuration
///////////////////////////////////////////////////////////////////////////
var mqttOptions = {
	connectTimeout: 30 * 1000,
	reconnectPeriod: 1000,
	keepAlive: 10,
	clean: true,
	resubscribe: true,
    clientId: 'AlexaConnect_' + Math.random().toString(16).substr(2, 8),
    username: mqtt_user,
    password: mqtt_password
};
///////////////////////////////////////////////////////////////////////////
// MQTT Connection
///////////////////////////////////////////////////////////////////////////
logger.log('info', "[MQTT] Connecting to MQTT server: " + mqtt_url);

mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	logger.log('error', "[MQTT] MQTT connect error");
});
mqttClient.on('reconnect', function(){
	logger.log('warn', "[MQTT] MQTT reconnect event");
});
mqttClient.on('connect', function(){
	logger.log('info', "[MQTT] MQTT connected, subscribing to 'response/#' and 'state/#'")
	mqttClient.subscribe('response/#');
	mqttClient.subscribe('state/#');
});
///////////////////////////////////////////////////////////////////////////
// MQTT Message Handlers
///////////////////////////////////////////////////////////////////////////
// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/");
	var username = arrTopic[1];
	var endpointId = arrTopic[2];
	var payload = JSON.parse(message.toString());
	var commandSource = undefined;
	logger.log('info', "[MQTT] Topic: " + topic);
	logger.log('info', "[MQTT] Payload: " + message);
	// Alexa uses messageId, GHome uses payload.messageId + endpointId as commands can contain multiple devices, this allows for collation
	var commandWaiting = (ongoingCommands[payload.messageId]);
	if (commandWaiting && commandWaiting.hasOwnProperty('source')){
		var commandSource = JSON.stringify(commandWaiting.source);
		commandSource = commandSource.replace(/['"]+/g, '');
	}

	if (commandWaiting && commandSource == "Alexa" && topic.startsWith('response/')) {
		logger.log('info', "[MQTT] Acknowledged Alexa MQTT response message for topic: " + topic);
		if (payload.success) {
			//logger.log('debug', "[Alexa API] MQTT response message is success for topic: " + topic);
			// Alexa success response send to Lambda for full response construction
			if (commandWaiting.hasOwnProperty('response')) {
				logger.log('debug', "[MQTT] Successful Alexa MQTT command for user: " + username + ", response: " + JSON.stringify(commandWaiting.response));
				commandWaiting.res.status(200).json(commandWaiting.response)
				delete ongoingCommands[payload.messageId];
			}
			else {
				logger.log('debug', "[MQTT] Successful Alexa MQTT command for user: " + username);
				commandWaiting.res.status(200).send()
				delete ongoingCommands[payload.messageId];
			}
		}
		else {
			// Alexa failure response send to Lambda for full response construction
			if (commandWaiting.hasOwnProperty('source')) {
				var commandSource = JSON.stringify(commandWaiting.source);
				commandSource = commandSource.replace(/['"]+/g, '');
				if (commandSource == "Alexa") {
					if (commandWaiting.hasOwnProperty('response')) {
						logger.log('warn', "[MQTT] Failed Alexa MQTT Command for user: " + username + ", response: " + + JSON.stringify(commandWaiting.response));
						commandWaiting.res.status(503).json(commandWaiting.response)
						delete ongoingCommands[payload.messageId];
					}
					else {
						logger.log('warn', "[MQTT] Failed Alexa MQTT Command for user: " + username);
						commandWaiting.res.status(503).send()
						delete ongoingCommands[payload.messageId];
					}
				}
			}
		}
	}
	/// End Alexa Response
	/// Start State Handler
	else if (topic.startsWith('state/')){
		logger.log('info', "[State API] Acknowledged MQTT state message topic: " + topic);
		logger.log('info', "[MQTT] Acknowledged MQTT State message for user: " + username + ", message: " + message);
		// Split topic/ get username and endpointId
		var messageJSON = JSON.parse(message);
		var payload = messageJSON.payload;
		// Call updateDeviceState to update state element in mongodb
		updateDeviceState(username, endpointId, payload) //arrTopic[1] is username, arrTopic[2] is endpointId
			.then(result => {
				if (result == true) {
					logger.log('verbose', "[MQTT] Successfully updated state for user: " + username + ", endpointId: " + endpointId);
				}
				else if (Array.isArray(result)){
					result.forEach(message => {
						notifyUser('warn', username, endpointId, message);
					});
				}
				else if (result == false){
					logger.log('warn', "[MQTT] Failed to updated state for user: " + username + ", endpointId: " + endpointId);
				}
			})
			.catch(e => {
				logger.log('error', "[MQTT] Error trying to update state for user: " + username + ", endpointId: " + endpointId + ", error" + e.stack);
			});
	}
	else {
		logger.log('debug', "[MQTT] Unhandled MQTT message event: " + topic + message);
	}
});

///////////////////////////////////////////////////////////////////////////
// Timer
///////////////////////////////////////////////////////////////////////////
var timeout = setInterval(function(){
	var now = Date.now();
	var maxTime = 2000;
	var keys = Object.keys(ongoingCommands);
	
	for (key in keys){

		var waiting = ongoingCommands[keys[key]];
		if (waiting && waiting.source == "Alexa") {
			var diff = now - waiting.timestamp;
			if (diff > maxTime) {
				try {
					waiting.res.status(504).send('{"error": "timeout"}');
					logger.log('warn', "[MQTT] Sent Alexa time-out response for user: " + waiting.user + ", message: " + keys[key]);
				}
				catch(e) {
					logger.log('error', "[MQTT] Error sending Alexa timeout response, error: " + e);
				}

				logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged for user: " + waiting.user + ", message: " + keys[key]);
				delete ongoingCommands[keys[key]];
			}
		}
		else {
			// Add cleanup for any misc. entries in ongoingCommands, there shouldn't be any!
			// delete ongoingCommands[keys[key]];
		}
	}
},500);

// Post MQTT message that users' Node-RED instance will display in GUI as warning
function notifyUser(severity, username, endpointId, message){
	var topic = "message/" + username + "/" + endpointId; // Prepare MQTT topic for client-side notifications
	var alert = {
		"severity" : severity,
		"message" : message
	}
	var alertString = JSON.stringify(alert);
	try {
		logger.log('debug', "[MQTT] Publishing MQTT alert, topic: " + topic + ", alert: " + alertString);
		mqttClient.publish(topic,alertString);
		logger.log('warn', "[MQTT] Published MQTT alert for user: " + username + " endpointId: " + endpointId + " message: " + alertString);
	} catch (err) {
		logger.log('error', "[MQTT] Failed to publish MQTT alert, error: " + err.stack);
	}
};

module.exports = {
	mqttClient,
 	ongoingCommands
}