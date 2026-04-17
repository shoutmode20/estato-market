import { escapeHtml, debounce } from '../js/modules/ui/utils';

describe('UI Utilities', () => {
    
    describe('escapeHtml', () => {
        it('should escape dangerous characters to prevent XSS', () => {
            const input = '<script>alert("hacked & owned")</script>';
            const output = escapeHtml(input);
            expect(output).toBe('&lt;script&gt;alert(&quot;hacked &amp; owned&quot;)&lt;/script&gt;');
        });

        it('should handle null or undefined safely', () => {
            expect(escapeHtml(null)).toBe('');
            expect(escapeHtml(undefined)).toBe('');
        });
    });

    describe('debounce', () => {
        jest.useFakeTimers();

        it('should delay function execution until wait time has elapsed', () => {
            const mockFn = jest.fn();
            const debouncedFn = debounce(mockFn, 100);

            debouncedFn();
            debouncedFn();
            debouncedFn();

            expect(mockFn).not.toHaveBeenCalled();

            jest.advanceTimersByTime(50);
            expect(mockFn).not.toHaveBeenCalled();

            jest.advanceTimersByTime(50);
            expect(mockFn).toHaveBeenCalledTimes(1);
        });
    });

});
