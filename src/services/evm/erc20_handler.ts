import { decodeAbiParameters, keccak256, toHex } from 'viem';
import { Dictionary } from 'lodash';
import { Erc20Activity, EvmEvent } from '../../models';
import { AccountBalance } from '../../models/account_balance';
import { ZERO_ADDRESS } from './constant';

export const ERC20_ACTION = {
  TRANSFER: 'transfer',
  APPROVAL: 'approval',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
};
export const ABI_TRANSFER_PARAMS = {
  FROM: {
    name: 'from',
    type: 'address',
  },
  TO: {
    name: 'to',
    type: 'address',
  },
  VALUE: {
    name: 'value',
    type: 'uint256',
  },
};
export const ABI_APPROVAL_PARAMS = {
  OWNER: {
    name: 'owner',
    type: 'address',
  },
  SPENDER: {
    name: 'spender',
    type: 'address',
  },
  VALUE: {
    name: 'value',
    type: 'uint256',
  },
};
export const ERC20_EVENT_TOPIC0 = {
  TRANSFER: keccak256(toHex('Transfer(address,address,uint256)')),
  APPROVAL: keccak256(toHex('Approval(address,address,uint256)')),
  DEPOSIT: keccak256(toHex('Deposit(address,uint256)')),
  WITHDRAWAL: keccak256(toHex('Withdrawal(address,uint256)')),
};
export class Erc20Handler {
  // key: {accountId}_{erc20ContractAddress}
  // value: accountBalance with account_id -> accountId, denom -> erc20ContractAddress
  accountBalances: Dictionary<AccountBalance>;

  erc20Activities: Erc20Activity[];

  constructor(
    accountBalances: Dictionary<AccountBalance>,
    erc20Activities: Erc20Activity[]
  ) {
    this.accountBalances = accountBalances;
    this.erc20Activities = erc20Activities;
  }

  process() {
    this.erc20Activities.forEach((erc20Activity) => {
      if (
        [
          ERC20_ACTION.TRANSFER,
          ERC20_ACTION.DEPOSIT,
          ERC20_ACTION.WITHDRAWAL,
        ].includes(erc20Activity.action)
      ) {
        this.handlerErc20Transfer(erc20Activity);
      }
    });
  }

  handlerErc20Transfer(erc20Activity: Erc20Activity) {
    // update from account balance if from != ZERO_ADDRESS
    if (erc20Activity.from !== ZERO_ADDRESS) {
      const fromAccountId = erc20Activity.from_account_id;
      const key = `${fromAccountId}_${erc20Activity.erc20_contract_address}`;
      const fromAccountBalance = this.accountBalances[key];
      if (
        !fromAccountBalance ||
        fromAccountBalance.last_updated_height <= erc20Activity.height
      ) {
        // calculate new balance: decrease balance of from account
        const amount = (
          BigInt(fromAccountBalance?.amount || 0) - BigInt(erc20Activity.amount)
        ).toString();
        // update object accountBalance
        this.accountBalances[key] = AccountBalance.fromJson({
          denom: erc20Activity.erc20_contract_address,
          amount,
          last_updated_height: erc20Activity.height,
          account_id: fromAccountId,
          type: AccountBalance.TYPE.ERC20_TOKEN,
        });
      }
    }
    // update to account balance
    const toAccountId = erc20Activity.to_account_id;
    const key = `${toAccountId}_${erc20Activity.erc20_contract_address}`;
    const toAccountBalance = this.accountBalances[key];
    if (
      !toAccountBalance ||
      toAccountBalance.last_updated_height <= erc20Activity.height
    ) {
      // calculate new balance: increase balance of to account
      const amount = (
        BigInt(toAccountBalance?.amount || 0) + BigInt(erc20Activity.amount)
      ).toString();
      // update object accountBalance
      this.accountBalances[key] = AccountBalance.fromJson({
        denom: erc20Activity.erc20_contract_address,
        amount,
        last_updated_height: erc20Activity.height,
        account_id: toAccountId,
        type: AccountBalance.TYPE.ERC20_TOKEN,
      });
    }
  }

  static buildTransferActivity(e: EvmEvent) {
    try {
      const [from, to, amount] = decodeAbiParameters(
        [
          ABI_TRANSFER_PARAMS.FROM,
          ABI_TRANSFER_PARAMS.TO,
          ABI_TRANSFER_PARAMS.VALUE,
        ],
        (e.topic1 + e.topic2.slice(2) + toHex(e.data).slice(2)) as `0x${string}`
      ) as [string, string, bigint];
      return Erc20Activity.fromJson({
        evm_event_id: e.id,
        sender: e.sender,
        action: ERC20_ACTION.TRANSFER,
        erc20_contract_address: e.address,
        amount: amount.toString(),
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        height: e.block_height,
        tx_hash: e.tx_hash,
        evm_tx_id: e.evm_tx_id,
      });
    } catch {
      return undefined;
    }
  }

  static buildApprovalActivity(e: EvmEvent) {
    try {
      const [from, to, amount] = decodeAbiParameters(
        [
          ABI_APPROVAL_PARAMS.OWNER,
          ABI_APPROVAL_PARAMS.SPENDER,
          ABI_APPROVAL_PARAMS.VALUE,
        ],
        (e.topic1 + e.topic2.slice(2) + toHex(e.data).slice(2)) as `0x${string}`
      ) as [string, string, bigint];
      return Erc20Activity.fromJson({
        evm_event_id: e.id,
        sender: e.sender,
        action: ERC20_ACTION.APPROVAL,
        erc20_contract_address: e.address,
        amount: amount.toString(),
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        height: e.block_height,
        tx_hash: e.tx_hash,
        evm_tx_id: e.evm_tx_id,
      });
    } catch {
      return undefined;
    }
  }

  static buildDepositActivity(e: EvmEvent) {
    try {
      const [to, amount] = decodeAbiParameters(
        [ABI_TRANSFER_PARAMS.TO, ABI_APPROVAL_PARAMS.VALUE],
        (e.topic1 + toHex(e.data).slice(2)) as `0x${string}`
      ) as [string, bigint];
      return Erc20Activity.fromJson({
        evm_event_id: e.id,
        sender: e.sender,
        action: ERC20_ACTION.DEPOSIT,
        erc20_contract_address: e.address,
        amount: amount.toString(),
        from: ZERO_ADDRESS,
        to: to.toLowerCase(),
        height: e.block_height,
        tx_hash: e.tx_hash,
        evm_tx_id: e.evm_tx_id,
      });
    } catch {
      return undefined;
    }
  }

  static buildWithdrawalActivity(e: EvmEvent) {
    try {
      const [from, amount] = decodeAbiParameters(
        [ABI_TRANSFER_PARAMS.FROM, ABI_APPROVAL_PARAMS.VALUE],
        (e.topic1 + toHex(e.data).slice(2)) as `0x${string}`
      ) as [string, bigint];
      return Erc20Activity.fromJson({
        evm_event_id: e.id,
        sender: e.sender,
        action: ERC20_ACTION.WITHDRAWAL,
        erc20_contract_address: e.address,
        amount: amount.toString(),
        from: from.toLowerCase(),
        to: ZERO_ADDRESS,
        height: e.block_height,
        tx_hash: e.tx_hash,
        evm_tx_id: e.evm_tx_id,
      });
    } catch {
      return undefined;
    }
  }
}
