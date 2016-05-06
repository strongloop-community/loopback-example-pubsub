// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

app.directive('psSong', function () {
    function link(scope) {
    }
    return {
      restrict: 'E',
      scope: {
        song: '='
      },
      templateUrl: '/modules/song/song.html',
      link: link
    };
});

app.directive('psNewSong', function () {
    function link(scope) {
      scope.add = function() {
        var playlist = scope.playlist;

        playlist.addSong(scope.url);

        delete scope.url;
      }
    }
    return {
      restrict: 'E',
      scope: {
        playlist: '='
      },
      templateUrl: '/modules/song/new-song.html',
      link: link
    };
});
