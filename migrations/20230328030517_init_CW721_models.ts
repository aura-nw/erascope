import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('cw721_contract', (table) => {
    table.increments('id').primary();
    table.string('code_id').index().notNullable();
    table.string('address').unique().index().notNullable();
    table.string('name').index().notNullable();
    table.string('symbol');
    table.string('minter');
    table.string('creator');
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('now()'));
    table.timestamp('updated_at').notNullable().defaultTo(knex.raw('now()'));
  });

  await knex.schema.createTable('cw721_token', (table) => {
    table.increments('id').primary();
    table.string('token_id').index().notNullable();
    table.string('token_uri');
    table.jsonb('extension');
    table.string('owner');
    table.string('contract_address').index().notNullable();
    table.foreign('contract_address').references('cw721_contract.address');
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('now()'));
    table.timestamp('delete_at');
  });

  await knex.schema.createTable('cw721_tx', (table) => {
    table.increments('id').primary();
    table.string('txhash').unique().index().notNullable();
    table.string('sender').index();
    table.string('action');
    table.string('contract_address').index().notNullable();
    table.foreign('contract_address').references('cw721_contract.address');
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('now()'));
    table.timestamp('updated_at').notNullable().defaultTo(knex.raw('now()'));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('cw721_tx');
  await knex.schema.dropTable('cw721_token');
  await knex.schema.dropTable('cw721_contract');
}
