app.controller('TestController', ['$scope', 'Playlist', function($scope, Playlist) {
  var testURL = 'https://soundcloud.com/cosmoknot/to-u';

  $scope.testSongs = [$scope.testSong];

  var playlist = $scope.playlist = new Playlist('1234567');

  playlist.addSong(testURL);

}]);
