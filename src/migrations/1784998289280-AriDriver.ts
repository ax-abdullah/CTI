import { MigrationInterface, QueryRunner } from "typeorm";

export class AriDriver1784998289280 implements MigrationInterface {
    name = 'AriDriver1784998289280'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pbx_connections" ADD "driver" character varying NOT NULL DEFAULT 'ami'`);
        await queryRunner.query(`ALTER TABLE "pbx_connections" ADD "ariApp" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pbx_connections" DROP COLUMN "ariApp"`);
        await queryRunner.query(`ALTER TABLE "pbx_connections" DROP COLUMN "driver"`);
    }

}
