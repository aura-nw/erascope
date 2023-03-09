export const APP_CONSTANTS = {
  VERSION_NUMBER: 1,
  VERSION: 'v1',
};

export const URL_TYPE_CONSTANTS = {
  LCD: 'LCD',
  RPC: 'RPC',
};

export const PROPOSAL_STATUS = {
  PROPOSAL_STATUS_UNSPECIFIED: 'PROPOSAL_STATUS_UNSPECIFIED',
  PROPOSAL_STATUS_DEPOSIT_PERIOD: 'PROPOSAL_STATUS_DEPOSIT_PERIOD',
  PROPOSAL_STATUS_VOTING_PERIOD: 'PROPOSAL_STATUS_VOTING_PERIOD',
  PROPOSAL_STATUS_PASSED: 'PROPOSAL_STATUS_PASSED',
  PROPOSAL_STATUS_REJECTED: 'PROPOSAL_STATUS_REJECTED',
  PROPOSAL_STATUS_FAILED: 'PROPOSAL_STATUS_FAILED',
  PROPOSAL_STATUS_NOT_ENOUGH_DEPOSIT: 'PROPOSAL_STATUS_NOT_ENOUGH_DEPOSIT',
};

export const PATH_COSMOS_SDK = {
  GET_LATEST_BLOCK_API: 'block?latest',
  GET_BLOCK_BY_HEIGHT_API: 'block?height=',
  GET_ALL_PROPOSAL: 'cosmos/gov/v1beta1/proposals',
  GET_PARAMS_BANK: 'cosmos/bank/v1beta1/params',
  GET_PARAMS_DISTRIBUTION: 'cosmos/distribution/v1beta1/params',
  GET_PARAMS_GOV_VOTING: 'cosmos/gov/v1beta1/params/voting',
  GET_PARAMS_GOV_TALLYING: 'cosmos/gov/v1beta1/params/tallying',
  GET_PARAMS_GOV_DEPOSIT: 'cosmos/gov/v1beta1/params/deposit',
  GET_PARAMS_SLASHING: 'cosmos/slashing/v1beta1/params',
  GET_PARAMS_STAKING: 'cosmos/staking/v1beta1/params',
  GET_PARAMS_IBC_TRANSFER: 'ibc/apps/transfer/v1/params',
  GET_PARAMS_MINT: 'cosmos/mint/v1beta1/params',
  GET_TX_API: 'cosmos/tx/v1beta1/txs/',
  GET_ALL_VALIDATOR: 'cosmos/staking/v1beta1/validators',
  GET_POOL: 'cosmos/staking/v1beta1/pool',
  GET_COMMUNITY_POOL: 'cosmos/distribution/v1beta1/community_pool',
  CODE_ID_URI: 'cosmwasm/wasm/v1/code/',
  CONTRACT_URI: 'cosmwasm/wasm/v1/contract/',
  GET_SIGNING_INFO: 'cosmos/slashing/v1beta1/signing_infos',
  GET_INFLATION: 'cosmos/mint/v1beta1/inflation',
  GET_PARAMS_DELEGATE_REWARDS: 'cosmos/distribution/v1beta1/delegators',
  GET_TX_API_EVENTS: 'cosmos/tx/v1beta1/txs',
  GET_TX_SEARCH: 'tx_search',
  GET_PARAMS_BALANCE: 'cosmos/bank/v1beta1/balances',
  GET_PARAMS_DELEGATE: 'cosmos/staking/v1beta1/delegations',
  GET_PARAMS_DELEGATOR: 'cosmos/staking/v1beta1/delegators',
  GET_PARAMS_AUTH_INFO: 'cosmos/auth/v1beta1/accounts',
  GET_PARAMS_SPENDABLE_BALANCE: 'cosmos/bank/v1beta1/spendable_balances',
  GET_PARAMS_IBC_DENOM: 'ibc/apps/transfer/v1/denom_traces',
  GET_VALIDATOR: 'cosmos/staking/v1beta1/validators/',
  GET_SUPPLY: 'cosmos/bank/v1beta1/supply',
  GET_DATA_HASH: 'cosmwasm/wasm/v1/code/',
  VERIFY_API_GET_HASH: 'api/v1/smart-contract/get-hash/',
  COSMWASM_CONTRACT_PARAM: 'cosmwasm/wasm/v1/contract/',
  SEARCH_TX: 'tx_search',
};

export const MODULE_PARAM = {
  BANK: 'bank',
  GOVERNANCE: 'gov',
  DISTRIBUTION: 'distribution',
  STAKING: 'staking',
  SLASHING: 'slashing',
  IBC_TRANSFER: 'ibc-transfer',
  MINT: 'mint',
};

export const BULL_JOB_NAME = {
  CRAWL_CHAIN_PROPERTY: 'crawl.chain-property',
  CRAWL_VALIDATOR: 'crawl.validator',
  CRAWL_SIGNING_INFO: 'crawl.signing-info',
  CRAWL_PARAM: 'crawl.param',
};

export const BULL_ACTION_NAME = {
  VALIDATOR_UPSERT: 'validator.upsert',
};

export const SERVICE_NAME = {
  CRAWL_VALIDATOR: 'CrawlValidatorService',
  CRAWL_PARAM: 'CrawlParamService',
  CRAWL_SIGNING_INFO: 'CrawlSigningInfoService',
  CRAWL_CHAIN_PROPERTY: 'CrawlChainPropertyService',
};
