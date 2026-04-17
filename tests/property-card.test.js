import { sortProperties, filterByRole, applyFilters, getSimilarProperties } from '../js/modules/ui/property-card';

// Sample fixture data
const makeProperty = (overrides = {}) => ({
    id: 'prop_001',
    title: 'Test Apartment',
    category: 'Apartment',
    type: 'Sale',
    status: 'Available',
    city: 'Mumbai',
    address: '12 MG Road',
    pinCode: '400001',
    price: 5000000,
    bhk: '2 BHK',
    area: 850,
    ownerId: 'user_seller_001',
    date: new Date('2024-01-15').toISOString(),
    ...overrides
});

describe('Property Card — sortProperties()', () => {
    const props = [
        makeProperty({ id: 'a', price: 3000000, date: new Date('2024-01-01').toISOString() }),
        makeProperty({ id: 'b', price: 8000000, date: new Date('2024-06-01').toISOString() }),
        makeProperty({ id: 'c', price: 1500000, date: new Date('2023-01-01').toISOString() }),
    ];

    it('sorts newest first by default', () => {
        const sorted = sortProperties(props, 'newest');
        expect(sorted[0].id).toBe('b');
    });

    it('sorts oldest first', () => {
        const sorted = sortProperties(props, 'oldest');
        expect(sorted[0].id).toBe('c');
    });

    it('sorts price low to high', () => {
        const sorted = sortProperties(props, 'price-low');
        expect(sorted[0].price).toBe(1500000);
    });

    it('sorts price high to low', () => {
        const sorted = sortProperties(props, 'price-high');
        expect(sorted[0].price).toBe(8000000);
    });

    it('does not mutate the original array', () => {
        const original = [...props];
        sortProperties(props, 'price-low');
        expect(props[0].id).toBe(original[0].id);
    });
});

describe('Property Card — filterByRole()', () => {
    const available = makeProperty({ id: 'avail', status: 'Available' });
    const pending   = makeProperty({ id: 'pend',  status: 'Pending', ownerId: 'seller_A' });
    const sold      = makeProperty({ id: 'sold',  status: 'Sold' });
    const allProps  = [available, pending, sold];

    it('Buyer only sees Available properties', () => {
        const result = filterByRole(allProps, { role: 'Buyer', id: 'buyer_1' });
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('avail');
    });

    it('Seller sees their own Pending and all non-Pending', () => {
        const result = filterByRole(allProps, { role: 'Seller', id: 'seller_A' });
        const ids = result.map(p => p.id);
        expect(ids).toContain('avail');
        expect(ids).toContain('pend');
        expect(ids).toContain('sold');
    });

    it("Seller cannot see another seller's Pending", () => {
        const result = filterByRole(allProps, { role: 'Seller', id: 'seller_B' });
        const ids = result.map(p => p.id);
        expect(ids).not.toContain('pend');
    });

    it('Admin sees everything', () => {
        const result = filterByRole(allProps, { role: 'Admin', id: 'admin_1' });
        expect(result.length).toBe(3);
    });
});

describe('Property Card — applyFilters()', () => {
    const props = [
        makeProperty({ id: 'a', city: 'Mumbai', type: 'Sale', title: 'Sea View Flat',  pinCode: '400001' }),
        makeProperty({ id: 'b', city: 'Delhi',  type: 'Rent', title: 'City Heights',   pinCode: '110001' }),
        makeProperty({ id: 'c', city: 'Mumbai', type: 'Rent', title: 'Ocean Retreat',  pinCode: '400002' }),
    ];

    it('filters by city', () => {
        const result = applyFilters(props, { cityFilter: 'Delhi' });
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('b');
    });

    it('filters by type', () => {
        const result = applyFilters(props, { typeFilter: 'Rent' });
        expect(result.length).toBe(2);
    });

    it('filters by search query matching title', () => {
        const result = applyFilters(props, { searchQuery: 'ocean' });
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('c');
    });

    it('filters by PIN code', () => {
        const result = applyFilters(props, { searchQuery: '400001' });
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('a');
    });
});

describe('Property Card — getSimilarProperties()', () => {
    const ref = makeProperty({ id: 'REF', city: 'Mumbai', category: 'Apartment', type: 'Sale', bhk: '2 BHK' });
    const similar = makeProperty({ id: 'SIM', city: 'Mumbai', category: 'Apartment', type: 'Sale', bhk: '2 BHK' });
    const different = makeProperty({ id: 'DIFF', city: 'Delhi', category: 'Villa', type: 'Rent', bhk: '4+ BHK' });

    it('returns similar properties excluding the reference property', () => {
        const result = getSimilarProperties(ref, [ref, similar, different]);
        const ids = result.map(p => p.id);
        expect(ids).not.toContain('REF');
        expect(ids).toContain('SIM');
    });
});
