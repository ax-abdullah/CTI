import { SupervisorService } from './supervisor.service';

describe('SupervisorService coaching mappings', () => {
  it('builds ChanSpy data with the right options', () => {
    expect(SupervisorService.chanSpyData('PJSIP/1001', 'spy')).toBe('PJSIP/1001,q');
    expect(SupervisorService.chanSpyData('PJSIP/1001', 'whisper')).toBe('PJSIP/1001,qw');
    expect(SupervisorService.chanSpyData('PJSIP/1001', 'barge')).toBe('PJSIP/1001,qB');
  });

  it('maps modes to ARI snoop directions', () => {
    expect(SupervisorService.snoopOpts('spy')).toEqual({ spy: 'in', whisper: 'none' });
    expect(SupervisorService.snoopOpts('whisper')).toEqual({ spy: 'in', whisper: 'out' });
    expect(SupervisorService.snoopOpts('barge')).toEqual({ spy: 'both', whisper: 'both' });
  });
});
