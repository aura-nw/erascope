import Long from 'long';

export interface INetworkInfo {
  chainName: string;
  chainId: string;
  RPC: string[];
  LCD: string[];
  prefixAddress: string;
  databaseName: string;
}

export interface ICoin {
  denom: string;
  amount: string;
}

export interface IPagination {
  limit?: Long;
  key?: Uint8Array;
}

export interface IDelegatorDelegations {
  delegatorAddr: string;
  pagination?: IPagination;
}

export interface IDelegatorRedelegations {
  delegatorAddr: string;
  srcValidatorAddr: string;
  dstValidatorAddr: string;
  pagination?: IPagination;
}

export interface IDelegatorUnbonding {
  delegatorAddr: string;
  pagination?: IPagination;
}

export interface IAllBalances {
  address: string;
  pagination?: IPagination;
}
