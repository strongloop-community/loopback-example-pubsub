// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

var Client = require('strong-pubsub');
var Adapter = require('strong-pubsub-mqtt');
var MOSQUITTO_PORT = process.env.MOSQUITTO_PORT || 1883;

module.exports = function(app) {
  var Song = app.models.Song;
  var client = new Client({port: MOSQUITTO_PORT}, Adapter);

  Song.observe('after save', function updateTimestamp(ctx, next) {
    var song = ctx.instance;
    if (song) {
      client.publish('/playlists/' + song.playlist, song.id.toString());
    }
    next();
  });
};
