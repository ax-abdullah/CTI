import { MigrationInterface, QueryRunner } from "typeorm";

export class AgentSip1784992237222 implements MigrationInterface {
    name = 'AgentSip1784992237222'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "agents" ADD "sipUsername" character varying`);
        await queryRunner.query(`ALTER TABLE "agents" ADD "sipPasswordEnc" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "sipPasswordEnc"`);
        await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "sipUsername"`);
    }

}
