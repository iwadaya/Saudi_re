import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NpLayerTable from './NpLayerTable.jsx';

const layers = [
  {
    layer: 'L1',
    limit: '1,000,000',
    deductible: '500,000',
    riskPureBurn: '4.00%',
    riskPareto: '2.00%',
    riskAvgBurnPareto: '3.00%',
    riskExposure: '5.00%',
    riskWeightBurn: '40',
    riskWeightPareto: '10',
    riskWeightExposure: '50',
    riskLoading: '15',
    riskTotalPrice: '5.50%',
    riskUwPrice: '6.00%',
    riskPrAttach: '12.00%',
    riskPrExhaust: '3.00%',
  },
  {
    layer: 'L2',
    limit: '2,000,000',
    deductible: '1,500,000',
    riskPureBurn: '6.00%',
    riskPareto: '4.00%',
    riskAvgBurnPareto: '5.00%',
    riskExposure: '7.00%',
    riskWeightBurn: '60',
    riskWeightPareto: '0',
    riskWeightExposure: '40',
    riskLoading: '20',
    riskTotalPrice: '7.50%',
    riskUwPrice: '8.00%',
    riskPrAttach: '8.00%',
    riskPrExhaust: '1.00%',
  },
];

describe('NpLayerTable', () => {
  it('renders weighted totals for risk layers', () => {
    render(<NpLayerTable section="RISK" rows={layers} layers={layers} updateLayer={() => {}} />);

    expect(screen.getByText('Risk XL Layers')).toBeInTheDocument();
    expect(screen.getByText('3,000,000')).toBeInTheDocument();
    expect(screen.getByText('5.33%')).toBeInTheDocument();
    expect(screen.getByText('7.33%')).toBeInTheDocument();
  });

  it('calls updateLayer with the original layer index and field name', () => {
    const updateLayer = vi.fn();
    render(<NpLayerTable section="RISK" rows={[layers[1]]} layers={layers} updateLayer={updateLayer} />);

    fireEvent.change(screen.getByDisplayValue('6.00%'), { target: { value: '6.50%' } });
    expect(updateLayer).toHaveBeenCalledWith(1, 'riskPureBurn', '6.50%');
  });

  it('locks editable controls when disabled', () => {
    render(<NpLayerTable section="RISK" rows={[layers[0]]} layers={layers} updateLayer={() => {}} disabled />);

    expect(screen.getByDisplayValue('4.00%')).toBeDisabled();
    expect(screen.getByDisplayValue('6.00%')).toBeDisabled();
  });

  it('renders the empty state by section', () => {
    render(<NpLayerTable section="CAT" rows={[]} layers={[]} updateLayer={() => {}} />);
    expect(screen.getByText('No cat layers configured.')).toBeInTheDocument();
  });
});
