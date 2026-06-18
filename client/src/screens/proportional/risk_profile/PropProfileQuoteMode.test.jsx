import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

let quoteMode = false;
const profileProps = [];

vi.mock('../../../context/AppContext', () => ({
  useAppState: () => ({ state: { quoteMode } }),
}));

vi.mock('../../shared/ProfileScreen', () => ({
  __esModule: true,
  default: function FakeProfileScreen(props) {
    profileProps.push(props);
    return <div data-testid={`profile-${props.profileType}`}>{props.quoteMode ? 'quote' : 'treaty'}</div>;
  },
}));

const { default: PropRiskProfile } = await import('./PropRiskProfile.jsx');
const { default: PropClaimsProfile } = await import('../claims_profile/PropClaimsProfile.jsx');

beforeEach(() => {
  quoteMode = false;
  profileProps.length = 0;
});

describe('proportional profile wrappers', () => {
  it('passes treaty mode by default', () => {
    render(<PropRiskProfile />);
    expect(screen.getByTestId('profile-risk')).toHaveTextContent('treaty');
    expect(profileProps[0]).toMatchObject({ profileType: 'risk', quoteMode: false });
  });

  it('passes quoteMode through for risk and claims profiles', () => {
    quoteMode = true;
    render(
      <>
        <PropRiskProfile />
        <PropClaimsProfile />
      </>,
    );

    expect(screen.getByTestId('profile-risk')).toHaveTextContent('quote');
    expect(screen.getByTestId('profile-claims')).toHaveTextContent('quote');
    expect(profileProps.map((p) => [p.profileType, p.quoteMode])).toEqual([
      ['risk', true],
      ['claims', true],
    ]);
  });
});
