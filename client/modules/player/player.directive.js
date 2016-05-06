// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

app.directive('psPlayer', function ($http, $interval, Song) {
    function link(scope) {
        var clientid = 'b23455855ab96a4556cbd0a98397ae8c';
        var song = scope.song;

        if(!song) return;

        $http({
          method: 'GET',
          url: 'https://api.soundcloud.com/resolve.json?client_id='+ clientid + '&url=' + song.scURL
        })
        .success(function (trackData) {
          $http({
            method: 'GET',
            url: 'http://api.soundcloud.com/tracks/'+trackData.id+'.json?client_id='+clientid
          })
          .success(function (data) {
            scope.band = data.user.username;
            scope.bandUrl = data.user.permalink_url;
            scope.title = data.title;
            scope.trackUrl = data.permalink_url;
            if(data.artwork_url) {
              scope.albumArt = data.artwork_url.replace("large", "t500x500");
            }
            scope.wave = data.waveform_url;
            scope.stream = data.stream_url + '?client_id=' + clientid;

            var audio = scope.audio = new Audio();
            audio.onended = function() {
              scope.onEnded();
            }
            audio.ontimeupdate = function() {
              scope.onProgress();
              scope.progress();
            }

            onPlayChanged();
          });
        });

        song.playing = song.playing || false;

        // watch song.playing
        scope.$watch('song.playing', function(newPlaying, oldPlaying) {
          if(newPlaying !== oldPlaying) {
            onPlayChanged();
          }
        });

        scope.togglePlay = function() {
          song.playing = !song.playing;          
          console.log('updateAttributes', song.id);

          Song.prototype$updateAttributes({ id: song.id }, {
            playing: song.playing
          });
        }

        function onPlayChanged() {
          if (song.playing) {
            if (!scope.audio.src) {
              scope.audio.src = scope.stream;
            }
            scope.audio.play();

            if (scope.onPlay) {
              scope.onPlay();
            }
          } else {
            scope.audio.pause();

            if (scope.onPause) {
              scope.onPause();
            }
          }
        }

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

        scope.currentTime = 0;

        scope.progress = function() {
          scope.currentTime = scope.audio.currentTime;
          scope.duration = scope.audio.duration;
          scope.$apply();
        }
    }
    return {
      restrict: 'E',
      scope: {
        song: '=',
        onPlay: '&',
        onPause: '&',
        onProgress: '&',
        onEnded: '&'
      },
      templateUrl: '/modules/player/player.html',
      link: link
    };
});
