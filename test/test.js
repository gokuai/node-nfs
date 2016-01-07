/**
 * Created by Meteor on 16/1/6.
 */
var statvfs = require('statvfs');

statvfs('/Users/Meteor/Documents', function (err, stats) {
    //assert.ifError(err); // on errno, will be a node ErrnoException
    console.log(JSON.stringify(stats, null, 2));
    /*
     {
     "bsize": 4096,
     "frsize": 4096,
     "blocks": 262144,
     "bfree": 252508,
     "bavail": 252508,
     "files": 292304,
     "ffree": 289126,
     "favail": 289126,
     "fsid": 140509193,
     "basetype": "tmpfs",
     "flag": 4,
     "namemax": 255,
     "fstr": "/tmp"
     }
     */
});

var disk = require('diskusage');

// get disk usage. Takes mount point as first parameter
disk.check('/Users/Meteor/Documents', function (err, info) {
    console.log('available', info.available);
    console.log('free', info.free);
    console.log('total', info.total);
});