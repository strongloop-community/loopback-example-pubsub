// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

app.directive('psProgress', function ($http, $interval) {
    function link(scope) {
        console.log('song', scope.song);
        scope.formatTime = function(time) {
          var minutes = Math.floor(time / 60);
          var seconds = Math.round(time - minutes * 60);

          if(minutes < 10) {
            minutes = '0' + minutes;
          }
          if(seconds < 10) {
            seconds = '0' + seconds;
          }
          return minutes + ':' + seconds;
        }
    }
    return {
      restrict: 'E',
      scope: {
        song: '='
      },
      templateUrl: '/modules/progress/progress.html',
      link: link
    };
});
