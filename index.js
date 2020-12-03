const request = require('request');
const cheerio = require('cheerio');
const crypto = require('crypto');
const AWS = require('aws-sdk');

if (typeof process.argv[2] === 'undefined') {
    console.log(`Usage:

    AWS_SECRET_ACCESS_KEY=xxx AWS_ACCESS_KEY_ID=yyy node index.js https://docs.google.com/document/d/1KXG_8-GjD7uxICw_JPC-YOhYY65n_F0GDAHvIUhCoUc/edit
`);
    process.exit(1);
}
const exampleTemplateUrl = 'https://docs.google.com/document/d/e/2PACX-1vQA5iy-l8G6v90lncp-5ZE4ugE03oE3TvDJH44pDqnimm4wefn8aEaF5eCTxXV14b6yNmAknCYOxbka/pub';
let exampleEssayUrl = process.argv[2] || 'https://docs.google.com/document/d/e/2PACX-1vQ2jncgUpg-CQ4DzKl9PgqNeU5E_ZfoxJugms8XMX71T8HZfZsZDIGX9q_Ie6g6CD-Z5HScxNnR5Blw/pub';
exampleEssayUrl = exampleEssayUrl.replace(/\/edit[^\/]*$/, '/pub');

function get(url, callback, retryCount = 0) {
    console.log(`[get] > GET ${url}`);
    request.get(url, function(error, response, responseText) {
        if (error || response.statusCode !== 200) {
            console.warn(`Error making GET request for ${url} (response code = ${response.statusCode})`);
            if (retryCount < 3) {
                console.log(`Making another GET request for ${url}`);
                return setTimeout(function() {
                    get(url, callback, retryCount + 1)
                }, 10);
            } else {
                console.error(`Giving up after failing ${retryCount} times to GET ${url}`);
                console.error(error.toString());
                return callback(error);
            }
        }

        // console.log(`[get] < ${response.statusCode} ${response.statusMessage}`);
        return callback(error, response, responseText);
    });
}

function computeHash(data) {
    const hash = crypto.createHash('sha256');
    hash.update(data)
    return hash.digest('hex');
}

function getTextContentFromHtmlString(html) {
    const $ = cheerio.load(html);
    const textContent = $.text();
    return textContent;
}

function extractTemplateHtml(html) {
    const textContent = getTextContentFromHtmlString(html.replace(/\u00A0/g, ' '));
    const matches = textContent.match(/@@@@(.+)@@@@/);
    if (matches && matches[1]) {
        return matches[1];
    } else {
        return "";
    }
}

function extractEssayData(html) {
    const $ = cheerio.load(html);
    const title = $('title').text();
    const cleanedHtml = $('body').html()
        .replace(/<a\s/ig, '<a target="_blank" ')
        .replace(/(<script[\s\S]+?<\/script>)/gi, '')
        .replace(/(<div id="header">[\s\S]+?<\/div>)/, '')
        .replace(/(<div id="footer">[\s\S]+?<\/div>)/, '');

    return {
        title,
        html: cleanedHtml,
        slug: title.replace(/[A-Z]/g, match => match.toLowerCase()).replace(/\s+/g, '-'),
    };
}


function getTemplate(templateUrl, callback) {
    get(templateUrl, function(error, response, responseText) {
        if (error) {
            console.error(`Error getting template HTML at ${templateUrl}`);
            return callback(error);
        }

        const templateHtml = extractTemplateHtml(responseText);
        callback(null, templateHtml);
    });
}

function getEssay(essayUrl, callback) {
    get(essayUrl, function(error, response, responseText) {
        if (error) {
            console.error(`Error getting essay ${essayUrl}`);
            return callback(error);
        }

        const { title, html, slug } = extractEssayData(responseText);
        return callback(null, {
            title,
            html,
            slug,
        });
    });
}

function parallel(fns, callback) {
    const results = [];
    let completionCount = 0;
    fns.forEach((fn, fnIndex) => {
        fn.call(this, function(error, result) {
            ++completionCount;
            results[fnIndex] = error || result;
            if (error) {
                return callback(error, results);
            } else if (completionCount === fns.length) {
                return callback(null, results);
            }
        });
    });
}

function putS3Object(key, body, callback, retryCount = 0) {
    const credentials = new AWS.EnvironmentCredentials('AWS');
    const s3 = new AWS.S3({
        apiVersion: '2006-03-01',
        region: 'us-east-1',
        credentials,
        maxRetries: 3,
    });
    const params = {
        ACL: 'public-read',
        Body: body,
        Bucket: 'brlknd',
        Key: key,
        ContentType: 'text/html; charset=utf-8',
    };

    s3.putObject(params, function(error, data) {
        if (error) {
            console.error(error, error.stack);
            if (retryCount < 3) {
                console.error(`Error while attempting to put object ${key} to S3. Trying again...`);
                return setTimeout(function() {
                    putS3Object(key, body, callback, retryCount + 1);
                }, 10);
            } else {
                console.error(`Giving up after ${retryCount} attempts to put object ${key} to S3`);
                return callback(error);
            }
        }

        console.log(`Success putting object to S3`);
        return callback(null, data);
    });
}

parallel([
    (callback) => getEssay(exampleEssayUrl, callback),
    (callback) => getTemplate(exampleTemplateUrl, callback)
], function(error, results) {
    if (error) {
        return;
    }

    const [ { title, html, slug }, templateHtml ] = results;
    const fullHtml = templateHtml
        .replace(/HTML_GOES_HERE/, html)
        .replace(/TITLE_GOES_HERE/, title);
    const hash = computeHash(fullHtml).substr(0, 8);
    const key = `${slug}-${hash}.html`;
    putS3Object(key, fullHtml, function() {
        console.log(`https://s3.amazonaws.com/brlknd/${key}`);
    });
});
