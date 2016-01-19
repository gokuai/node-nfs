/**
 * Created by root on 1/19/16.
 */
var bunyan = require('bunyan');
var path = require('path');
var ALY = require('aliyun-sdk');

var logFile = path.join(__dirname, '../queue.log');
var logger = bunyan.createLogger({
    name: name,
    level: process.env.LOG_LEVEL || 'error',
    src: true,
    streams: [{
        type: 'file',
        path: logFile
    }],
});

var libOSS = new ALY.OSS({
    "accessKeyId": 'ACSpY7WtwtOZJYFG',
    "secretAccessKey": 'CjQwnI6peo',
    "endpoint": 'http://oss-cn-hangzhou.aliyuncs.com',
    "apiVersion": "2013-10-15"
});
var ossStream = require('oss-upload-stream')(libOSS);
var bucket = 'gktest2';

var textSched = later.parse.text('every 1 min');
var timer = later.setInterval(upload, textSched);

function upload() {
    console.log(new Date());
    var upload = ossStream.upload({
        "Bucket": bucket,
        "Key": f
    });

    db.all("SELECT rowid AS id, info FROM lorem", function(err, rows) {
        rows.forEach(function (row) {
            console.log(row.id + ": " + row.info);
        });
    });

// Handle errors.
    upload.on('error', function (error) {
        console.log('ossStream error', error);
    });
// Handle upload completion.
    upload.on('uploaded', function (details) {
        console.log('ossStream uploaded', details);
    });
// Pipe the incoming filestream through compression, and upload to Aliyun OSS.
    fs.createReadStream(f).pipe(upload);
}

