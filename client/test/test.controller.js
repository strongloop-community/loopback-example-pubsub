// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

app.controller('TestController', ['$scope', 'Playlist', function($scope, Playlist) {
  var testURL = 'https://soundcloud.com/cosmoknot/to-u';

  $scope.testSongs = [$scope.testSong];

  var playlist = $scope.playlist = new Playlist('1234567');

  playlist.addSong(testURL);

}]);
