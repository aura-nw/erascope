import { BeforeEach, Describe, Test } from '@jest-decorated/core';
import { ServiceBroker } from 'moleculer';
import knex from '../../../../src/common/utils/db_connection';
import CreateConstraintInEvmEventPartitionJob from '../../../../src/services/evm/job/create_constraint_in_evm_event_partition.service';
import { EvmEvent } from '../../../../src/models';

@Describe('Test create constraint for evm_event partition')
export default class CreateConstraintEvmEventPartitionSpec {
  broker = new ServiceBroker({ logger: false });

  createConstraintInEvmEventPartitionJob?: CreateConstraintInEvmEventPartitionJob;

  private async insertFakeEvmEventWithInputId(
    desiredId: number
  ): Promise<void> {
    await EvmEvent.query().insert(
      EvmEvent.fromJson({
        id: desiredId,
        tx_id: desiredId,
        evm_tx_id: 1,
        address: 'test',
        topic0: 'test',
        topic1: 'test',
        block_height: desiredId,
        tx_hash: 'test',
        tx_index: desiredId,
        block_hash: 'test',
      })
    );
  }

  private async isConstraintNameExist(
    partitionName: string,
    constraintName: string
  ): Promise<boolean> {
    const constraintResult = await knex.raw(`
        SELECT
            connamespace::regnamespace "schema",
            conrelid::regclass "table",
            conname "constraint",
            pg_get_constraintdef(oid) "definition"
        FROM pg_constraint
        WHERE conrelid = '${partitionName}'::regclass and conname like '${constraintName}'
    `);
    return !!constraintResult.rows[0];
  }

  @BeforeEach()
  async initSuite() {
    this.createConstraintInEvmEventPartitionJob = this.broker.createService(
      CreateConstraintInEvmEventPartitionJob
    ) as CreateConstraintInEvmEventPartitionJob;
  }

  @Test('Test create constraint on first evm event partition')
  public async test1() {
    await knex.raw(
      `TRUNCATE TABLE ${EvmEvent.tableName} RESTART IDENTITY CASCADE`
    );
    const partitions =
      await this.createConstraintInEvmEventPartitionJob?.getEvmEventPartitionInfo();

    // We have 1 partition by default after run migration
    // We have 1 partition by default after run migration
    expect(partitions?.length).toEqual(1);
    if (!partitions) throw Error('No partition found');

    // Now partition is empty so result return will be empty and no constraint create
    const emptyStatus =
      await this.createConstraintInEvmEventPartitionJob?.createEvmEventConstraint(
        partitions[0]
      );
    expect(emptyStatus).toEqual(
      this.createConstraintInEvmEventPartitionJob
        ?.createConstraintEvmEventStatus.currentPartitionEmpty
    );

    // After insert one tx, now we expect constraint created
    await this.insertFakeEvmEventWithInputId(Number(partitions[0].fromId) + 1);
    const constraintUpdated =
      await this.createConstraintInEvmEventPartitionJob?.createEvmEventConstraint(
        partitions[0]
      );
    expect(constraintUpdated).toEqual(
      this.createConstraintInEvmEventPartitionJob
        ?.createConstraintEvmEventStatus.constraintUpdated
    );

    // Verify constraint created
    const expectedInsertingConstraintName = `evm_event_ct_${partitions[0].name}_${this.createConstraintInEvmEventPartitionJob?.insertionStatus.inserting}`;
    const isInsertingConstraintExist = await this.isConstraintNameExist(
      partitions[0].name,
      expectedInsertingConstraintName
    );
    expect(isInsertingConstraintExist).toEqual(true);

    // After insert next tx, because id now not reach to max id of partition, and we already have constraint created before, so now status will be still inserting or done
    await this.insertFakeEvmEventWithInputId(Number(partitions[0].fromId) + 10);
    const stillInsertingOrDont =
      await this.createConstraintInEvmEventPartitionJob?.createEvmEventConstraint(
        partitions[0]
      );
    expect(stillInsertingOrDont).toEqual(
      this.createConstraintInEvmEventPartitionJob
        ?.createConstraintEvmEventStatus.currentPartitionDoneOrInserting
    );

    // After insert tx with id reach to max id of partition, now partition is ready for create full constraint, constraint now will be updated
    await this.insertFakeEvmEventWithInputId(Number(partitions[0].toId) - 1);
    const constraintCreatedDone =
      await this.createConstraintInEvmEventPartitionJob?.createEvmEventConstraint(
        partitions[0]
      );
    expect(constraintCreatedDone).toEqual(
      this.createConstraintInEvmEventPartitionJob
        ?.createConstraintEvmEventStatus.constraintUpdated
    );

    // Verify constraint created
    const expectedDoneConstraintName = `evm_event_ct_${partitions[0].name}_${this.createConstraintInEvmEventPartitionJob?.insertionStatus.done}`;
    const isDoneConstraintExist = await this.isConstraintNameExist(
      partitions[0].name,
      expectedDoneConstraintName
    );
    const isInsertingConstraintNotExist = await this.isConstraintNameExist(
      partitions[0].name,
      expectedInsertingConstraintName
    );
    expect(isDoneConstraintExist).toEqual(true);
    expect(isInsertingConstraintNotExist).toEqual(false);

    const checkAgainStatus =
      await this.createConstraintInEvmEventPartitionJob?.createEvmEventConstraint(
        partitions[0]
      );
    expect(checkAgainStatus).toEqual(
      this.createConstraintInEvmEventPartitionJob
        ?.createConstraintEvmEventStatus.currentPartitionDoneOrInserting
    );

    await knex.raw(`
      ALTER TABLE ${partitions[0].name} DROP CONSTRAINT ${expectedDoneConstraintName};
    `);
  }
}
