/*
 * index.js :: include for the binarypack modules
 *
 * (C) 2013 Jarrett Cruger -- MIT
 *
 */

var fs = require('fs'),
    path = require('path');

module.exports = require('binarypack');

//
// Expose source of browser code to be loaded by primus
//
module.exports.BrowserSource = fs.readFileSync(
  path.join(__dirname, './vendor/binarypack.js')
, 'utf-8');


