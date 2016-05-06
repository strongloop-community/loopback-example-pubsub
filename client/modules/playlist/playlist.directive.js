// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

app.directive('psPlaylist', function ($http, $interval) {
    function link(scope) {
    }
    return {
      restrict: 'E',
      scope: {
        playlist: '='
      },
      templateUrl: '/modules/playlist/playlist.html',
      link: link
    };
});
