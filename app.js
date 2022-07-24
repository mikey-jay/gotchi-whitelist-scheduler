require('dotenv').config();

// Can be 'safeLow', 'standard', or 'fast' - see: https://gasstation-mainnet.matic.network/v2
const GAS_SPEED = 'standard'

// Abort the operation if estimated gas exceeds this limit, specified in MATIC
const GAS_COST_LIMIT_MATIC = 0.25

const ABI = require('./abi.js')
const SCHEDULES = require('./schedules.js')
const POLYGON_RPC_HOST = process.env.POLYGON_RPC_HOST || "https://polygon-rpc.com/"
const POLYGON_GAS_STATION_HOST = "https://gasstation-mainnet.matic.network/v2"
const AAVEGOTCHI_DIAMOND_ADDRESS = "0x86935F11C86623deC8a25696E1C19a8659CbF95d"

const WHITELIST_WALLET_ADDRESS = process.env.WHITELIST_WALLET_ADDRESS
const WHITELIST_WALLET_KEY = process.env.WHITELIST_WALLET_KEY
const WHITELIST_ID = parseInt(process.env.WHITELIST_ID) || 0

const MAX_LENDINGS = 999

const MILLISECONDS_BETWEEN_RETRIES = 1000 * 60 * 2 // 2 minutes

// cancel only mode - just cancel any current listings matching the config gotchi ids
const CLEAR_ONLY = process.argv.includes('--clear')

// run once mode - runs once and then exits
const RUN_ONCE = process.argv.includes('--once') || CLEAR_ONLY

// In offline mode, no transactions are sent to the blockchain
const OFFLINE_MODE = process.argv.includes('--offline')

const getLogTimestamp = () => (new Date()).toISOString().substring(0,19)
const log = (message) => console.log(`${getLogTimestamp()}: ${message}`)

const Web3 = require('web3')
const web3 = new Web3(POLYGON_RPC_HOST)
const contract = new web3.eth.Contract(ABI, AAVEGOTCHI_DIAMOND_ADDRESS)

const convertGweiToWei = (gwei) => gwei * (10 ** 9)
const convertWeiToMatic = (wei) => wei / (10 ** 18)

const getCurrentGasPrices = () => new Promise((resolve, reject) => {
  const https = require('https')
  https.get(POLYGON_GAS_STATION_HOST, (res) =>{
    const { statusCode } = res
    let rawData = ''
    res.on('data', (chunk) => rawData += chunk)
    res.on('end', () => {
      const gasData = JSON.parse(rawData)
      if (gasData['error'])
        reject(new Error(`Polygon gas station error: ${gasData.error.message}`))
      else if (typeof gasData[GAS_SPEED] == 'undefined')
        reject(new Error(`Polygon gas station response does not include any data for gas speed '${GAS_SPEED}' (rawData=${rawData})`))
      else
        resolve(gasData)
    })
  })
})

const createUpdateWhitelistTransaction = async (addresses) => {
  return {
    from: WHITELIST_WALLET_ADDRESS,
    to: AAVEGOTCHI_DIAMOND_ADDRESS,
    data: contract.methods.updateWhitelist(WHITELIST_ID, addresses).encodeABI()
  }
}

const createRemoveAddressTransaction = async (addresses) => {
  return {
    from: WHITELIST_WALLET_ADDRESS,
    to: AAVEGOTCHI_DIAMOND_ADDRESS,
    data: contract.methods.removeAddressesFromWhitelist(WHITELIST_ID, addresses).encodeABI()
  }
}

const setTransactionGasToMarket = async (tx) => Object.assign({
    gasLimit: await web3.eth.estimateGas(tx),
    maxPriorityFeePerGas: Math.ceil(convertGweiToWei((await getCurrentGasPrices())[GAS_SPEED].maxPriorityFee)) 
  }, tx)

const signTransaction = (unsignedTransaction) => web3.eth.accounts.signTransaction(unsignedTransaction, WHITELIST_WALLET_KEY)
const sendTransaction = (signedTransaction) => web3.eth.sendSignedTransaction(signedTransaction.rawTransaction)

const notifySending = (payload) => log('Sending transaction...')
const notifySent = (payload) => log('Transaction sent.')
const notifyHash = (hash) => log('Transaction hash is ' + hash)
const notifyReceipt = (receipt) => log(`Obtained receipt for transaction (blockNumber=${receipt.blockNumber}, gasUsed=${receipt.gasUsed}, effectiveGasPrice=${receipt.effectiveGasPrice})`)
const notifyComplete = (receipt) => log('Transaction complete.')
const notifyError = (error) => Promise.reject(error)

async function submitTransaction(addresses, transactionFactory) {

  log(`Submitting ${transactionFactory.name} with addresses:\n\t${addresses.join('\n\t')}`)

  try {
    var transaction = await setTransactionGasToMarket(await transactionFactory(addresses))
  } catch (err) {
    return Promise.reject(err)
  }
  log(`Creating ${transactionFactory.name} transaction: (addresses=${addresses}, from=${transaction.from}, to=${transaction.to}, gasLimit=${transaction.gasLimit}, maxPriorityFeePerGas=${transaction.maxPriorityFeePerGas})`)
  const estimatedGasCostMatic = convertWeiToMatic(transaction.gasLimit * (transaction.maxPriorityFeePerGas + convertGweiToWei((await getCurrentGasPrices()).estimatedBaseFee)))
  log("Estimated gas cost is ~" + estimatedGasCostMatic.toFixed(6) + " MATIC")
  if (estimatedGasCostMatic > GAS_COST_LIMIT_MATIC) {
    log('ABORTED: Estimated gas cost exceeds limit. GAS_COST_LIMIT_MATIC=' + GAS_COST_LIMIT_MATIC)
  } else {
    return await sendTransaction(await signTransaction(transaction))
      .once('sending', notifySending)
      .once('sent', notifySent)
      .once('transactionHash', notifyHash)
      .once('receipt', notifyReceipt)
      .on('error', notifyError)
      .then(notifyComplete).catch(notifyError)
  }
}

const addAddressesToWhitelist = (addresses) => (addresses.length == 0) ? clearWhitelist() : submitTransaction(addresses, createUpdateWhitelistTransaction).catch((err) => log(`Error updating whitelist: ${err.message}`))
const removeAddressesFromWhitelist = (addresses) => submitTransaction(addresses, createRemoveAddressTransaction).catch((err) => log(`Error removing addresses from whitelist: ${err.message}`))
const clearWhitelist = async () => removeAddressesFromWhitelist(await getWhitelistAddresses(WHITELIST_ID))
const getWhitelist = (id) => contract.methods.getWhitelist(id).call()
const getWhitelistAddresses = async (id) => (await getWhitelist(id))['addresses'].map((s) => s.toLowerCase())
const getCurrentUTCDatetimeString = () => new Date().toISOString().slice(0,16)
const isScheduledNow = (schedule) => { const now = getCurrentUTCDatetimeString() ; return schedule.startTime <= now && schedule.endTime > now }

const loop = async () => {
  log(`WHITELIST_WALLET_ADDRESS=${WHITELIST_WALLET_ADDRESS}`)
  log(`WHITELIST_ID=${WHITELIST_ID}`)
  const wlAddresses = await getWhitelistAddresses(WHITELIST_ID)
  const scheduledAddresses = SCHEDULES.filter(isScheduledNow).map((s) => s.address.toLowerCase())
  const addressesToAdd = scheduledAddresses.filter((address) => !wlAddresses.includes(address))
  const addressesToRemove = wlAddresses.filter((address) => !scheduledAddresses.includes(address))
  log(`whitelistAddresses=\n\t${wlAddresses.join('\n\t')}`)
  log(`scheduledAddresses=\n\t${scheduledAddresses.join('\n\t')}`)

  if (OFFLINE_MODE) {
    log('Offline mode is enabled, no transactions will be sent.')
    return
  }

  if (CLEAR_ONLY) {
    log('Clearing addresses from whitelist')
    return clearWhitelist()
  }

  if (!CLEAR_ONLY) {
    const addIfNeeded = async () => {
      if (addressesToAdd.length > 0)
        return addAddressesToWhitelist(addressesToAdd)
    }
    const removeIfNeeded = async () => {
      if (addressesToRemove.length > 0)
        return removeAddressesFromWhitelist(addressesToRemove)
    }
    return addIfNeeded().catch(log).finally(removeIfNeeded)
  }
}
loop().catch(log).finally(() => { if (!RUN_ONCE) setInterval(loop, MILLISECONDS_BETWEEN_RETRIES) } )