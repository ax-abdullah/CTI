import { RoutingService } from './routing.service';

describe('RoutingService.decide', () => {
  const svc = new RoutingService();

  it('routes an unknown caller to the default queue, normal priority', () => {
    const d = svc.decide('+966500000000', null);
    expect(d).toMatchObject({ known: false, priority: 'normal', queue: 'general' });
    expect(d.variables).toMatchObject({ CTI_KNOWN: 'false', CTI_PRIORITY: 'normal', CTI_QUEUE: 'general' });
    expect(d.prompt).toBeUndefined();
  });

  it('routes a VIP contact to the priority queue and greets them', () => {
    const d = svc.decide('+966511111111', { name: 'Acme CEO', vip: true });
    expect(d).toMatchObject({ known: true, priority: 'vip', queue: 'priority', contactName: 'Acme CEO' });
    expect(d.variables.CTI_CONTACT_NAME).toBe('Acme CEO');
    expect(d.prompt).toBe('sound:welcome');
  });

  it('honors a known contact preferred queue (non-VIP)', () => {
    const d = svc.decide('+966522222222', { name: 'Sara', queue: 'support' });
    expect(d).toMatchObject({ known: true, priority: 'normal', queue: 'support' });
  });

  it('known contact without a preferred queue falls back to default', () => {
    expect(svc.decide('x', { name: 'Bob' }).queue).toBe('general');
  });
});
