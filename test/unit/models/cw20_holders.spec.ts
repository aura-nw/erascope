import { BeforeAll, Describe, Test } from '@jest-decorated/core';
import { expect } from '@jest/globals';
import { CW20Token, ICW20Token } from '../../../src/models/cw20_tokens.model';
import knex from '../../../src/common/utils/db-connection';
import {
  CW20Holder,
  ICW20Holder,
} from '../../../src/models/cw20_holders.model';

@Describe('Test cw20_holders model')
export default class CW20HoldersTest {
  holder: ICW20Holder = {
    address: 'aura122222',
    balance: BigInt(1000000000),
    contract_address: 'aura546543213241564',
  };

  token: ICW20Token = {
    code_id: '1',
    asset_info: {
      data: { name: '', symbol: '', decimals: 10, total_supply: '' },
    },
    contract_address: 'aura546543213241564',
    marketing_info: {
      data: { project: '', description: '', logo: { url: '' }, marketing: '' },
    },
  };

  @BeforeAll()
  async initSuite() {
    await knex('cw20_holders').del();
    await knex('cw20_tokens').del();
    await CW20Token.query().insert(this.token);
    await CW20Holder.query().insert(this.holder);
  }

  @Test('Test query')
  public async testQuery() {
    const holder = await CW20Holder.query().first();
    expect(holder).not.toBeUndefined();
    expect(holder?.address).toBe('aura122222');
  }

  @Test('Test update')
  public async testUpdate() {
    await CW20Holder.query()
      .update({ address: 'phamphong' })
      .where('address', 'aura122222');
    const holder = await CW20Holder.query()
      .where('address', 'phamphong')
      .first();
    expect(holder).not.toBeUndefined();
  }

  @Test('Test get datetime')
  public async testDateTime() {
    const holder = await CW20Holder.query().first();
    expect(holder).not.toBeUndefined();
    // eslint-disable-next-line no-console
    console.log(holder?.created_at?.getMonth(), holder?.id);
  }

  @Test('Test insert')
  public async testInsert() {
    await CW20Holder.query().insert({
      address: 'aura33333333',
      balance: BigInt(1000000000),
      contract_address: 'aura546543213241564',
    });
    const holder = await CW20Holder.query()
      .where('address', 'aura33333333')
      .first();
    expect(holder).not.toBeUndefined();
  }
}
