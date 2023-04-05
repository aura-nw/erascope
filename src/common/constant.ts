export const REDIS_KEY = {
  IBC_DENOM: 'ibc_denom',
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
  CRAWL_VALIDATOR: 'crawl:validator',
  CRAWL_GENESIS_VALIDATOR: 'crawl:genesis-validator',
  CRAWL_SIGNING_INFO: 'crawl:signing-info',
  HANDLE_ADDRESS: 'handle:address',
  CRAWL_GENESIS_ACCOUNT: 'crawl:genesis-account',
  CRAWL_ACCOUNT_AUTH: 'crawl:account-auth',
  CRAWL_ACCOUNT_BALANCES: 'crawl:account-balances',
  CRAWL_ACCOUNT_SPENDABLE_BALANCES: 'crawl:account-spendable-balances',
  CRAWL_BLOCK: 'crawl:block',
  CRAWL_TRANSACTION: 'crawl:transaction',
  HANDLE_TRANSACTION: 'handle:transaction',
  HANDLE_ASSET_TRANSACTION: 'handle:asset-tx',
  ENRICH_CW721: 'enrich:cw721',
  ENRICH_CW20: 'enrich:cw20',
};

export const SERVICE = {
  V1: {
    CrawlAccount: {
      name: 'v1.CrawlAccountService',
      UpdateAccount: {
        key: 'UpdateAccount',
        path: 'v1.CrawlAccountService.UpdateAccount',
      },
    },
    HandleAddress: {
      name: 'v1.HandleAddressService',
      CrawlNewAccountApi: {
        key: 'CrawlNewAccountApi',
        path: 'v1.HandleAddressService.CrawlNewAccountApi',
      },
    },
    Cw721: {
      name: 'v1.Cw721Service',
      EnrichCw721: {
        key: 'enrichCw721',
        path: 'v1.Cw721Service.enrichCw721',
      },
    },
  },
};

export const SERVICE_NAME = {
  CRAWL_VALIDATOR: 'CrawlValidatorService',
  CRAWL_SIGNING_INFO: 'CrawlSigningInfoService',
  HANDLE_ADDRESS: 'HandleAddressService',
  CRAWL_ACCOUNT: 'CrawlAccountService',
  CRAWL_BLOCK: 'CrawlBlockService',
  CRAWL_TRANSACTION: 'CrawlTransaction',
  ASSET_INDEXER: 'AssetTxIndexerService',
  CW721: 'Cw721Service',
};

export enum AccountType {
  CONTINUOUS_VESTING = '/cosmos.vesting.v1beta1.ContinuousVestingAccount',
  PERIODIC_VESTING = '/cosmos.vesting.v1beta1.PeriodicVestingAccount',
  DELAYED_VESTING = '/cosmos.vesting.v1beta1.DelayedVestingAccount',
  MODULE = '/cosmos.auth.v1beta1.ModuleAccount',
  BASE = '/cosmos.auth.v1beta1.BaseAccount',
}

export const BLOCK_CHECKPOINT_JOB_NAME = {
  BLOCK_HEIGHT_CRAWLED: 'BLOCK_HEIGHT_CRAWLED',
  TX_ASSET_HANDLER: 'TX_ASSET_HANDLER',
};

export const MSG_TYPE = {
  MSG_STORE_CODE: '/cosmwasm.wasm.v1.MsgStoreCode',
  MSG_INSTANTIATE_CONTRACT: '/cosmwasm.wasm.v1.MsgInstantiateContract',
  MSG_EXECUTE_CONTRACT: '/cosmwasm.wasm.v1.MsgExecuteContract',
  MSG_UPDATE_CLIENT: '/ibc.core.client.v1.MsgUpdateClient',
};

export const ATTRIBUTE_KEY = {
  CONTRACT_ADDRESS: '_contract_address',
  TOKEN_ID: 'token_id',
  FROM: 'from',
  TO: 'to',
  AMOUNT: 'amount',
  ACTION: 'action',
  SENDER: 'sender',
  RECIPIENT: 'recipient',
};

export const EVENT_TYPE = {
  WASM: 'wasm',
  EXECUTE: 'execute',
  INSTANTIATE: 'instantiate',
};

export const CONTRACT_TYPES = {
  CW20: 'CW20',
  CW721: 'CW721',
  CW4973: 'CW4973',
};
export const ABCI_QUERY_PATH = {
  VALIDATOR_DELEGATION: '/cosmos.staking.v1beta1.Query/Delegation',
};

export const CW20_ACTION = {
  URL_GET_OWNER_LIST: 'eyJhbGxfYWNjb3VudHMiOiB7fX0=',
  URL_GET_TOKEN_INFO: 'eyJ0b2tlbl9pbmZvIjoge319',
  URL_GET_MARKETING_INFO: 'eyJtYXJrZXRpbmdfaW5mbyI6IHt9fQ==',
  GET_OWNER_LIST: 'v1.CW20.getOwnerList',
  GET_BALANCE: 'v1.CW20.getBalance',
  ENRICH_DATA: 'v1.CW20.enrichData',
  GET_MARKET_INFO: 'v1.CW20.getMarketInfo',
};
