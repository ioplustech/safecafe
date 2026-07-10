const fs = require('fs');
const { resolve } = require('path');
const { rpcPing } = require('./rpcPing');
const getChainList = require(resolve(__dirname, 'getChainList.json'));
const chains = getChainList.chains;

const util = require('util');
const asyncSleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  bgRedLight: '\x1b[41;37m',     // 错误背景
  bgYellowLight: '\x1b[43;30m',  // 警告背景
  bgGreenLight: '\x1b[42;37m',   // 成功背景
};

const logger = {
  red: (...args) => console.log(colors.red + colors.bold + '✖', formatArgs(args), colors.reset),
  green: (...args) => console.log(colors.green + colors.bold + '✔', formatArgs(args), colors.reset),
  yellow: (...args) => console.log(colors.yellow + colors.bold + '★', formatArgs(args), colors.reset),
  warn: (...args) => console.log(colors.yellow + colors.bold + '⚠', formatArgs(args), colors.reset),
  error: (...args) => console.log(colors.red + colors.bold + '✖', formatArgs(args), colors.reset),
  success: (...args) => console.log(colors.green + colors.bold + '✔', formatArgs(args), colors.reset),
};

// 核心：完美处理任意参数（对象会自动美化）
function formatArgs(args) {
  return args.map(arg => {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return arg;

    // util.inspect 比 JSON.stringify 更强大（支持 BigInt、函数、循环引用等）
    return util.inspect(arg, { colors: true, depth: null, breakLength: Infinity });
  }).join(' ');
}

const getNetworkName = (name) => {
  if (/sepolia/gim.test(name)) {
    return 'Ethereum Sepolia';
  }
  if (/mainnet|ethereum/gim.test(name)) {
    return 'Ethereum Mainnet';
  }
  if (/hoodi/gim.test(name)) {
    return 'Ethereum Hoodi';
  }
  if (/hole/gim.test(name)) {
    return 'Holesky';
  }
  if (/stable/gim.test(name)) {
    return 'Stable Testnet';
  }
  if (/gnosis/gim.test(name)) {
    return 'Gnosis';
  }
  return '';
};
const networkList = [
  'gnosis',
  'sepolia',
  'holesky',
  'ethereum',
  'stable',
  'hoodi',
];
async function testRpc(chain) {
  const { name, rpc: rpcList } = chain;
  logger.green(` Testing ${ name } ${ rpcList.length } rpcs!`);
  const updatedRpcList = await Promise.all(rpcList.map(async (rpc) => {
    try {
      const result = await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 8000)),
        new Promise(async (resolve, reject) => {
          try {
            await rpcPing(rpc.url, 8000);
            resolve(true);
          } catch (error) {
            reject(error);
          }
        }),
      ]);
      if (result === true) {
        delete rpc.status;
      } else {
        rpc.status = 'invalid';
      }
    } catch (error) {
      console.log();
      logger.warn(`${ name } ${ rpc.url } is invalid: ${ error.message }`);
      rpc.status = 'invalid';
    } finally {
      return rpc;
    }
  }));
  logger.green(`${ name } ${ updatedRpcList.filter((rpc) => rpc.status !== 'invalid').length } valid rpcs!`);
  return updatedRpcList;
}
async function updateChainList(chains, chain) {
  const index = chains.findIndex((c) => c.name === chain.name);
  chains[index] = chain;
  fs.writeFileSync('./getChainList.json', JSON.stringify({ chains }, null, 2));
  logger.green('Chain list updated!');
}
async function updateSingle(name) {
  if (!name) {
    logger.red('No network name found');
    return;
  }
  const chain = chains.find((chain) => chain.name === name);
  if (!chain) {
    logger.red(`Chain not found for network: ${ name }`);
    return;
  }
  const rpcList = await testRpc(chain);
  chain.rpc = rpcList;
  await updateChainList(chains, chain);
}
async function main() {
  const fromChainArg = process.argv.slice(2).find((arg) => arg.includes('from'));
  const isAll = process.argv.slice(2).find((arg) => arg.includes('all'));
  if (!fromChainArg && !isAll) {
    logger.red('Please provide from parameter (e.g., from=sepolia or --all)');
    return;
  }
  if (fromChainArg) {
    logger.green(`Update network: ${ fromChainArg }`);
    const from = fromChainArg.split('=')[1];
    await updateSingle(getNetworkName(from));
  }
  if (isAll) {
    logger.green('Update all networks');
    for (const network of networkList) {
      await updateSingle(getNetworkName(network));
      logger.green(`Update network: ${ network } done!`);
      await asyncSleep(100)
    }
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      logger.red(error);
      process.exit(1);
    });
}