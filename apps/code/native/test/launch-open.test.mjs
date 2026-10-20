import test from 'node:test';
import assert from 'node:assert/strict';
import { launchShopURL } from '../public/js/launch-open.js';

test('a launch click opens only the public Shop, for a known OS and a known company', () => {
  for (const url of ['https://imperfect.computer/shop', 'https://imperfect.computer/shop?os=mac', 'https://imperfect.computer/shop?os=linux',
    'https://imperfect.computer/shop?os=mac&for=kinso', 'https://imperfect.computer/shop?for=kinso']) assert.equal(launchShopURL(url), url, url);
  for (const url of ['https://imperfect.computer/shop?os=amiga', 'https://imperfect.computer/shop?for=evil', 'https://imperfect.computer/shop?for=kinso&os=mac',
    'https://imperfect.computer/shop?os=mac&os=linux', 'https://imperfect.computer/shop?os=mac&for=kinso&for=kinso', 'https://imperfect.computer/shop?os=mac&x=1',
    'https://imperfect.computer/account', 'https://evil.test/shop?os=mac', 'https://imperfect.computer/shop?os=mac#x', 'http://imperfect.computer/shop',
    'https://u:p@imperfect.computer/shop', 42, 'https://imperfect.computer/shop?os=mac&for=' + 'k'.repeat(300)]) assert.equal(launchShopURL(url), null, String(url));
});

test('the Kinso concept opens on kinso.computer, not the other store; only its exact canonical URL is accepted', () => {
  const concept = 'https://kinso.computer/kinso/';
  assert.equal(launchShopURL(concept), concept);
  for (const url of ['http://kinso.computer/kinso/', 'https://www.kinso.computer/kinso/', 'https://kinso.computer/kinso',
    'https://kinso.computer:443/kinso/', 'https://kinso.computer/kinso/?x=1', 'https://kinso.computer/kinso/?v=kinso-embed-1', 'https://kinso.computer/kinso/#',
    'https://kinso.computer.evil.test/kinso/', 'https://u:p@kinso.computer/kinso/', 'https://kinso.computer/kinso/../']) {
    assert.equal(launchShopURL(url), null, url);
  }
});
