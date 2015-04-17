var Transport = require('..');

describe.skip('index', function(done) {
  it('should return a connection object', function(done) {
    var conn = Transport.createConnection('localhost', 0);
    console.log(conn);
    done();
  });
});
