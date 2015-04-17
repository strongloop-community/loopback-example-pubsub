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
