const https = require('https');
const fs = require('fs');
const path = require('path');

// Try chainid.network first (raw ethereum-lists data), fall back to chainlist.org.
// Both sources are normalized into one { chains: [...] } shape with rpc: [{ url }],
// so downstream consumers (e.g. getChainList.live.js) see a consistent format.

// chainid.network returns rpc as string[]; chainlist.org returns rpc as [{ url, ... }].
// Unify both to [{ url }] (string -> { url }; objects already in that shape pass through).
const normalizeRpc = (rpcList) => {
  if (!Array.isArray(rpcList)) return [];
  return rpcList.map((item) => (typeof item === 'string' ? { url: item } : item));
};

const normalizeChainIdList = (arr) => ({
  chains: arr.map((chain) => ({ ...chain, rpc: normalizeRpc(chain.rpc) })),
});

const chainlistTask = async () => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'chainlist.org',
      path: '/',
      method: 'GET',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'priority': 'u=0, i',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'referer': 'https://chainlist.org/',
        'origin': 'https://chainlist.org',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      }
    };

    console.log("starting fetch chainlist.org");
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const match = data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (!match || !match[1]) {
            throw new Error('Failed to find __NEXT_DATA__ script');
          }
          const jsonStr = match[1];
          const jsonObj = JSON.parse(jsonStr);
          const pageProps = jsonObj.props.pageProps;
          const chains = pageProps.chains || [];
          fs.writeFileSync(path.join(__dirname, 'getChainList.json'), JSON.stringify({ chains }, null, 2));
          console.log('Successfully saved getChainList.json from chainlist.org');
          resolve(chains);
        } catch (error) {
          console.error('Error:', error.message);
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      console.error('Request error:', error.message);
      reject(error);
    });

    req.end();
  });
};

const chainIdTask = async () => {
  return new Promise((resolve, reject) => {
    console.log('starting fetch chainid.network');
    const req = https.request(
      {
        hostname: 'chainid.network',
        path: '/chains.json',
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              throw new Error(`chainid.network returned status ${res.statusCode}`);
            }
            const arr = JSON.parse(data);
            if (!Array.isArray(arr)) {
              throw new Error('chainid.network response is not an array');
            }
            const { chains } = normalizeChainIdList(arr);
            fs.writeFileSync(path.join(__dirname, 'getChainList.json'), JSON.stringify({ chains }, null, 2));
            console.log(`Successfully saved getChainList.json from chainid.network (${chains.length} chains)`);
            resolve(chains);
          } catch (error) {
            console.error('Error:', error.message);
            reject(error);
          }
        });
      },
    );

    req.on('error', (error) => {
      console.error('Request error:', error.message);
      reject(error);
    });

    req.setTimeout(20000, () => {
      req.destroy(new Error('chainid.network request timeout'));
    });

    req.end();
  });
};

// Primary: chainid.network. Fallback: chainlist.org.
const run = async () => {
  try {
    await chainIdTask();
  } catch (error) {
    console.error(`chainid.network failed, falling back to chainlist.org: ${error.message}`);
    await chainlistTask();
  }
};

if (require.main === module) {
  run().catch((error) => {
    console.error('Error:', error.message);
  });
}

module.exports = { normalizeRpc, normalizeChainIdList };