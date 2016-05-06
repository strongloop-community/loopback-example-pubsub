// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

var app = angular.module('ps', ['lbServices']);

app.controller('AppController', function($scope, Playlist) {
  var playlistId;

  if(window.location.hash) {
    playlistId = window.location.hash.replace('#', '');
  }

  var playlist = $scope.playlist = new Playlist(playlistId);

  window.location.hash = playlist.id;

  // update the playlist
  playlist.getSongs();
});
